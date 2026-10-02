import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/**
 * Code Workspace Java execution tracer (visualizer).
 *
 * Launches the program in a second JVM through JDI and single-steps every line
 * of the project's classes on the main thread, recording the call stack with
 * `this`, parameters and locals, and every object reachable from them. JDK
 * collections are read from their internal fields and nothing in the program
 * is ever invoked, so recording cannot change what it does. Writes the trace as
 * JSON when the program ends; program output is passed through unchanged.
 *
 *     java -cp <adapter classes> CwTracer <config.json>
 */
public final class CwTracer {
    private static final String[] EXCLUDES = {"java.*", "javax.*", "sun.*", "jdk.*", "com.sun.*", "kotlin.*"};

    private final Map<String, Object> config;
    private final List<String> projectFiles = new ArrayList<>();
    private final long maxSteps, maxObjects, maxItems, maxString, maxBytes;
    private final List<String> steps = new ArrayList<>();
    private long size;
    private String truncated;
    private boolean recording = true;

    private VirtualMachine vm;
    private EventRequestManager erm;
    private ThreadReference mainThread;
    private final List<EventRequest> tracingRequests = new ArrayList<>();

    // Program stdout: forwarded, counted (in chars) and kept for the trace.
    private final Object outLock = new Object();
    private InputStream programOut;
    private Process process;
    private final ByteArrayOutputStream pending = new ByteArrayOutputStream();
    private final StringBuilder kept = new StringBuilder();
    private long stdoutChars;

    @SuppressWarnings("unchecked")
    private CwTracer(Map<String, Object> config) {
        this.config = config;
        for (Object f : (List<Object>) config.get("files")) projectFiles.add((String) f);
        Map<String, Object> limits = (Map<String, Object>) config.get("limits");
        maxSteps = ((Number) limits.get("maxSteps")).longValue();
        maxObjects = ((Number) limits.get("maxObjectsPerStep")).longValue();
        maxItems = ((Number) limits.get("maxItemsPerObject")).longValue();
        maxString = ((Number) limits.get("maxStringChars")).longValue();
        maxBytes = ((Number) limits.get("maxTraceBytes")).longValue();
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        Map<String, Object> config = (Map<String, Object>) CwDebugAdapter.Json.parse(Files.readString(Path.of(args[0])));
        System.exit(new CwTracer(config).run());
    }

    // ------------------------------------------------------------- run

    private int run() throws Exception {
        LaunchingConnector connector = Bootstrap.virtualMachineManager().defaultConnector();
        Map<String, Connector.Argument> cargs = connector.defaultArguments();
        cargs.get("main").setValue((String) config.get("mainClass"));
        cargs.get("options").setValue("-cp " + config.get("classpath") + " " + config.get("vmOptions"));
        cargs.get("suspend").setValue("true");
        if (config.get("javaHome") != null) cargs.get("home").setValue((String) config.get("javaHome"));
        vm = connector.launch(cargs);
        erm = vm.eventRequestManager();

        Process p = vm.process();
        process = p;
        p.getOutputStream().close(); // the launcher wrapper gives the program its stdin directly
        programOut = p.getInputStream();
        Thread outPump = new Thread(this::pumpStdout, "stdout-pump");
        outPump.setDaemon(true);
        outPump.start();
        Thread errPump = new Thread(() -> copy(p.getErrorStream(), System.err), "stderr-pump");
        errPump.setDaemon(true);
        errPump.start();

        ClassPrepareRequest cpr = erm.createClassPrepareRequest();
        cpr.addClassFilter((String) config.get("mainClass"));
        cpr.enable();

        eventLoop();

        Integer code = null;
        try {
            code = p.waitFor() & 0xFF;
        } catch (InterruptedException ignored) {
            // Unknown.
        }
        outPump.join(2000);
        errPump.join(2000);
        drainStdout();
        System.out.flush();
        writeTrace();
        return code == null ? 1 : code;
    }

    private void eventLoop() throws InterruptedException {
        EventQueue queue = vm.eventQueue();
        while (true) {
            EventSet set;
            try {
                set = queue.remove();
            } catch (VMDisconnectedException e) {
                return;
            }
            for (Event e : set) {
                try {
                    handle(e);
                } catch (VMDisconnectedException ex) {
                    return;
                } catch (Exception ex) {
                    stopRecording("Recording failed: " + ex);
                }
                if (e instanceof VMDisconnectEvent) return;
            }
            try {
                set.resume();
            } catch (VMDisconnectedException ex) {
                return;
            }
        }
    }

    /** Where the last recorded line step was, and whether an accessor has been passed over since. */
    private boolean afterAccessor;
    private int lastDepth = -1;
    private int lastLine = -1;
    private Method lastMethod;

    private void handle(Event e) throws Exception {
        if (e instanceof ClassPrepareEvent) {
            ReferenceType type = ((ClassPrepareEvent) e).referenceType();
            for (Method m : type.methodsByName("main")) {
                if (!m.isStatic() || m.location() == null) continue;
                BreakpointRequest bp = erm.createBreakpointRequest(m.location());
                bp.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                bp.addCountFilter(1);
                bp.enable();
            }
            erm.deleteEventRequest(e.request());
        } else if (e instanceof BreakpointEvent) {
            erm.deleteEventRequest(e.request());
            // A second main (Kotlin's own, called by the one the JVM starts) is reached while already stepping.
            if (mainThread != null) return;
            mainThread = ((BreakpointEvent) e).thread();
            startStepping();
            if (inProject(((BreakpointEvent) e).location())) record(mainThread, "line", null, null);
        } else if (e instanceof StepEvent) {
            StepEvent se = (StepEvent) e;
            Location loc = se.location();
            if (!recording) return;
            if (!inProject(loc)) {
                if (isPropertyAccessor(loc)) afterAccessor = true;
                return;
            }
            // Back from a property accessor that was passed over: the same line again, with nothing changed, is not another step.
            int depth = se.thread().frameCount();
            boolean again = afterAccessor && depth == lastDepth && loc.lineNumber() == lastLine && loc.method().equals(lastMethod);
            afterAccessor = false;
            lastDepth = depth;
            lastLine = loc.lineNumber();
            lastMethod = loc.method();
            if (!again) record(se.thread(), "line", null, null);
        } else if (e instanceof MethodExitEvent) {
            MethodExitEvent me = (MethodExitEvent) e;
            if (recording && inProject(me.location())) record(me.thread(), "return", me.returnValue(), null);
        } else if (e instanceof ExceptionEvent) {
            ExceptionEvent ee = (ExceptionEvent) e;
            if (recording && inProject(ee.location())) record(ee.thread(), "exception", null, describeException(ee.exception()));
        }
    }

    private void startStepping() {
        StepRequest step = erm.createStepRequest(mainThread, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
        MethodExitRequest exit = erm.createMethodExitRequest();
        exit.addThreadFilter(mainThread);
        ExceptionRequest ex = erm.createExceptionRequest(null, true, true);
        ex.addThreadFilter(mainThread);
        for (String pattern : EXCLUDES) {
            step.addClassExclusionFilter(pattern);
            exit.addClassExclusionFilter(pattern);
            ex.addClassExclusionFilter(pattern);
        }
        for (EventRequest r : List.of(step, exit, ex)) {
            r.setSuspendPolicy(EventRequest.SUSPEND_ALL);
            r.enable();
            tracingRequests.add(r);
        }
    }

    private void stopRecording(String reason) {
        if (!recording) return;
        recording = false;
        truncated = reason;
        for (EventRequest r : tracingRequests) {
            try {
                erm.deleteEventRequest(r);
            } catch (Exception ignored) {
                // The VM may be gone.
            }
        }
    }

    // --------------------------------------------------------- stdout

    /**
     * Forwards program stdout while the program runs. Every read happens under
     * outLock and only for bytes already available, so output drained by
     * record() and by this pump can never be reordered.
     */
    private void pumpStdout() {
        try {
            while (true) {
                if (drainStdout()) continue;
                if (!process.isAlive()) {
                    drainStdout();
                    return;
                }
                Thread.sleep(2);
            }
        } catch (InterruptedException ignored) {
            // Shutting down.
        }
    }

    /** Reads whatever program output is already available. Returns false when there was none. */
    private boolean drainStdout() {
        synchronized (outLock) {
            try {
                int n = programOut.available();
                if (n <= 0) return false;
                byte[] buf = new byte[n];
                int read = programOut.read(buf, 0, n);
                if (read > 0) accept(buf, read);
                return read > 0;
            } catch (IOException e) {
                return false;
            }
        }
    }

    private void accept(byte[] buf, int n) {
        System.out.write(buf, 0, n);
        System.out.flush();
        pending.write(buf, 0, n);
        // Count only complete UTF-8 sequences; keep a trailing partial one for next time.
        byte[] all = pending.toByteArray();
        int end = all.length;
        int k = end - 1;
        while (k >= 0 && k >= end - 3 && (all[k] & 0xC0) == 0x80) k--;
        if (k >= 0 && (all[k] & 0x80) != 0) {
            int need = (all[k] & 0xE0) == 0xC0 ? 2 : (all[k] & 0xF0) == 0xE0 ? 3 : 4;
            if (end - k < need) end = k;
        }
        String text = new String(all, 0, end, StandardCharsets.UTF_8);
        pending.reset();
        pending.write(all, end, all.length - end);
        stdoutChars += text.length();
        if (kept.length() < 1_000_000) kept.append(text, 0, Math.min(text.length(), 1_000_000 - kept.length()));
    }

    private static void copy(InputStream in, PrintStream out) {
        byte[] buf = new byte[8192];
        try {
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                out.flush();
            }
        } catch (IOException ignored) {
            // Closed.
        }
    }

    // -------------------------------------------------------- recording

    private void record(ThreadReference thread, String event, Value returnValue, String exception) throws Exception {
        if (!recording) return;
        if (steps.size() >= maxSteps) {
            stopRecording("Recording stopped after " + maxSteps + " steps; the program continued without recording.");
            return;
        }
        // Output printed before this point belongs before this step.
        drainStdout();

        Map<String, Object> heap = new LinkedHashMap<>();
        Encoder enc = new Encoder(heap);
        List<StackFrame> all = thread.frames();
        List<Object> frames = new ArrayList<>();
        for (int k = all.size() - 1; k >= 0; k--) {
            StackFrame f = all.get(k);
            Location loc = f.location();
            String file = projectFileFor(loc);
            if (file == null) continue;
            List<Object> locals = new ArrayList<>();
            ObjectReference self = f.thisObject();
            if (self != null) locals.add(List.of("this", enc.value(self)));
            try {
                for (LocalVariable lv : f.visibleVariables()) locals.add(List.of(lv.name(), enc.value(f.getValue(lv))));
            } catch (AbsentInformationException ignored) {
                // Compiled without -g.
            }
            Method m = loc.method();
            String name = simpleName(loc.declaringType().name()) + "." + (m.isConstructor() ? "<init>" : m.name());
            Map<String, Object> frame = CwDebugAdapter.obj("name", name, "file", file, "line", loc.lineNumber(), "locals", locals);
            if (k == 0 && "return".equals(event) && returnValue != null && !(returnValue instanceof VoidValue)) {
                frame.put("returnValue", enc.value(returnValue));
            }
            frames.add(frame);
        }
        enc.drain();

        Map<String, Object> step = CwDebugAdapter.obj("event", event, "frames", frames, "heap", heap, "stdoutLength", stdoutChars);
        if (exception != null) step.put("exception", exception);
        String json = CwDebugAdapter.Json.write(step);
        size += json.length() + 1;
        if (size > maxBytes) {
            stopRecording("Recording stopped because the trace grew too large; the program continued without recording.");
            return;
        }
        steps.add(json);
    }

    private void writeTrace() throws IOException {
        Map<String, Object> head = CwDebugAdapter.obj("language", "java", "stdout", kept.toString());
        if (truncated != null) head.put("truncated", truncated);
        String h = CwDebugAdapter.Json.write(head);
        try (Writer w = Files.newBufferedWriter(Path.of((String) config.get("out")), StandardCharsets.UTF_8)) {
            w.write(h, 0, h.length() - 1);
            w.write(",\"steps\":[");
            for (int k = 0; k < steps.size(); k++) {
                if (k > 0) w.write(',');
                w.write(steps.get(k));
            }
            w.write("]}");
        }
    }

    private String describeException(ObjectReference ex) {
        String text = ex.referenceType().name();
        Field f = ex.referenceType().fieldByName("detailMessage");
        if (f != null) {
            Value v = ex.getValue(f);
            if (v instanceof StringReference) text += ": " + ((StringReference) v).value();
        }
        return text;
    }

    // -------------------------------------------------------- files

    private boolean inProject(Location loc) {
        return projectFileFor(loc) != null;
    }

    /**
     * A Kotlin property's own getter or setter (`node.next` runs `getNext()`): a
     * few instructions the compiler wrote, on the line the property is declared.
     * Reading a property is not a call anyone wrote, so it is not stepped into.
     */
    private static boolean isPropertyAccessor(Location loc) {
        Method m = loc.method();
        String name = m.name();
        boolean named = (name.startsWith("get") || name.startsWith("set")) && name.length() > 3 && Character.isUpperCase(name.charAt(3))
            || name.startsWith("is") && name.length() > 2 && Character.isUpperCase(name.charAt(2));
        if (!named) return false;
        try {
            return loc.sourceName().endsWith(".kt") && m.bytecodes().length <= 16;
        } catch (Exception e) {
            return false;
        }
    }

    private String projectFileFor(Location loc) {
        // Code the compiler added on its own (Kotlin's main(String[]) that calls the program's main()) is not the program's.
        if (loc.lineNumber() <= 0 || loc.method().isSynthetic() || loc.method().isBridge()) return null;
        if (isPropertyAccessor(loc)) return null;
        String sourcePath;
        try {
            sourcePath = loc.sourcePath();
        } catch (AbsentInformationException e) {
            return null;
        }
        if (projectFiles.contains(sourcePath)) return sourcePath;
        String base = sourcePath.substring(sourcePath.lastIndexOf('/') + 1);
        String match = null;
        for (String f : projectFiles) {
            if (f.equals(sourcePath) || f.endsWith("/" + sourcePath) || (!sourcePath.contains("/") && (f.equals(base) || f.endsWith("/" + base)))) {
                if (match != null) return null;
                match = f;
            }
        }
        return match;
    }

    private static String simpleName(String type) {
        int k = type.lastIndexOf('.');
        return k < 0 ? type : type.substring(k + 1);
    }

    // -------------------------------------------------------- values

    /** Encodes values; objects are added to the step's heap breadth-first, within the limits. */
    private final class Encoder {
        private final Map<String, Object> heap;
        private final Deque<ObjectReference> queue = new ArrayDeque<>();

        Encoder(Map<String, Object> heap) { this.heap = heap; }

        Object value(Value v) {
            if (v == null) return inline("null", "null");
            if (v instanceof CharValue) return inline("'" + escape(String.valueOf(((CharValue) v).value())) + "'", "char");
            if (v instanceof PrimitiveValue) return inline(v.toString(), v.type().name());
            if (v instanceof StringReference) return inline(quoted(((StringReference) v).value()), "String");
            ObjectReference o = (ObjectReference) v;
            String boxed = unbox(o);
            if (boxed != null) return inline(boxed, simpleName(o.referenceType().name()));
            String enumName = enumConstant(o);
            if (enumName != null) return inline(simpleName(o.referenceType().name()) + "." + enumName, simpleName(o.referenceType().name()));
            String id = String.valueOf(o.uniqueID());
            if (!heap.containsKey(id)) {
                if (heap.size() >= maxObjects) return inline("<" + simpleName(o.referenceType().name()) + ">", simpleName(o.referenceType().name()));
                heap.put(id, null);
                queue.add(o);
            }
            return CwDebugAdapter.obj("kind", "ref", "id", id);
        }

        void drain() {
            while (!queue.isEmpty()) {
                ObjectReference o = queue.poll();
                heap.put(String.valueOf(o.uniqueID()), describe(o));
            }
        }

        private Map<String, Object> describe(ObjectReference o) {
            ReferenceType type = o.referenceType();
            String name = type.name();
            if (o instanceof ArrayReference) {
                ArrayReference a = (ArrayReference) o;
                int n = (int) Math.min(a.length(), maxItems);
                List<Object> items = new ArrayList<>();
                if (n > 0) for (Value x : a.getValues(0, n)) items.add(value(x));
                return trim(CwDebugAdapter.obj("kind", "sequence", "type", simpleName(name), "items", items), a.length(), n);
            }
            switch (name) {
                case "java.util.ArrayList":
                case "java.util.Vector":
                case "java.util.Stack":
                    return arrayList(o, name);
                case "java.util.LinkedList":
                    return linkedList(o);
                case "java.util.ArrayDeque":
                    return arrayDeque(o);
                case "java.util.PriorityQueue":
                    return priorityQueue(o);
                case "java.util.HashMap":
                case "java.util.LinkedHashMap":
                    return hashMap(o, name);
                case "java.util.TreeMap":
                    return treeMap(o);
                case "java.util.HashSet":
                case "java.util.LinkedHashSet":
                case "java.util.TreeSet":
                    return set(o, name);
                default:
                    break;
            }
            if (isJdk(name)) {
                // JDK internals (Scanner, streams, lambdas...) are not the program's data.
                return CwDebugAdapter.obj("kind", "other", "type", simpleName(name), "text", simpleName(name) + " object");
            }
            List<Object> fields = new ArrayList<>();
            int total = 0;
            for (Field f : type.allFields()) {
                if (f.isStatic() || f.isSynthetic()) continue;
                total++;
                if (fields.size() < maxItems) fields.add(List.of(f.name(), value(o.getValue(f))));
            }
            return trim(CwDebugAdapter.obj("kind", "object", "type", simpleName(name), "fields", fields), total, fields.size());
        }

        private Map<String, Object> arrayList(ObjectReference o, String name) {
            Value data = field(o, "elementData");
            Value size = field(o, name.equals("java.util.ArrayList") ? "size" : "elementCount");
            List<Object> items = new ArrayList<>();
            int n = size instanceof IntegerValue ? ((IntegerValue) size).value() : 0;
            int shown = (int) Math.min(n, maxItems);
            if (data instanceof ArrayReference && shown > 0) for (Value x : ((ArrayReference) data).getValues(0, shown)) items.add(value(x));
            return trim(CwDebugAdapter.obj("kind", "sequence", "type", simpleName(name), "items", items), n, shown);
        }

        private Map<String, Object> linkedList(ObjectReference o) {
            List<Object> items = new ArrayList<>();
            Value size = field(o, "size");
            int n = size instanceof IntegerValue ? ((IntegerValue) size).value() : 0;
            Value node = field(o, "first");
            while (node instanceof ObjectReference && items.size() < maxItems) {
                items.add(value(field((ObjectReference) node, "item")));
                node = field((ObjectReference) node, "next");
            }
            return trim(CwDebugAdapter.obj("kind", "sequence", "type", "LinkedList", "items", items), n, items.size());
        }

        /** Head to tail, following the circular buffer. */
        private Map<String, Object> arrayDeque(ObjectReference o) {
            List<Object> items = new ArrayList<>();
            Value data = field(o, "elements");
            Value head = field(o, "head");
            Value tail = field(o, "tail");
            int n = 0;
            if (data instanceof ArrayReference && head instanceof IntegerValue && tail instanceof IntegerValue) {
                ArrayReference a = (ArrayReference) data;
                int cap = a.length();
                int h = ((IntegerValue) head).value();
                int t = ((IntegerValue) tail).value();
                n = cap == 0 ? 0 : ((t - h) % cap + cap) % cap;
                for (int i = 0; i < n && items.size() < maxItems; i++) items.add(value(a.getValue((h + i) % cap)));
            }
            return trim(CwDebugAdapter.obj("kind", "sequence", "type", "ArrayDeque", "items", items), n, items.size());
        }

        /** The backing array in heap order: the smallest (by the ordering) first, children of i at 2i+1 and 2i+2. */
        private Map<String, Object> priorityQueue(ObjectReference o) {
            List<Object> items = new ArrayList<>();
            Value data = field(o, "queue");
            Value size = field(o, "size");
            int n = size instanceof IntegerValue ? ((IntegerValue) size).value() : 0;
            int shown = (int) Math.min(n, maxItems);
            if (data instanceof ArrayReference && shown > 0) for (Value x : ((ArrayReference) data).getValues(0, shown)) items.add(value(x));
            return trim(CwDebugAdapter.obj("kind", "sequence", "type", "PriorityQueue", "items", items), n, shown);
        }

        private Map<String, Object> hashMap(ObjectReference o, String name) {
            List<Object> entries = new ArrayList<>();
            Value size = field(o, "size");
            int n = size instanceof IntegerValue ? ((IntegerValue) size).value() : 0;
            if (name.equals("java.util.LinkedHashMap")) {
                // Insertion order: head/after links.
                Value e = field(o, "head");
                while (e instanceof ObjectReference && entries.size() < maxItems) {
                    ObjectReference node = (ObjectReference) e;
                    entries.add(List.of(value(field(node, "key")), value(field(node, "value"))));
                    e = field(node, "after");
                }
            } else {
                Value table = field(o, "table");
                if (table instanceof ArrayReference) {
                    for (Value bucket : ((ArrayReference) table).getValues()) {
                        Value e = bucket;
                        while (e instanceof ObjectReference && entries.size() < maxItems) {
                            ObjectReference node = (ObjectReference) e;
                            if (node.referenceType().name().endsWith("TreeNode")) break; // treeified bucket; rare in small programs
                            entries.add(List.of(value(field(node, "key")), value(field(node, "value"))));
                            e = field(node, "next");
                        }
                        if (entries.size() >= maxItems) break;
                    }
                }
            }
            return trim(CwDebugAdapter.obj("kind", "map", "type", simpleName(name), "entries", entries), n, entries.size());
        }

        private Map<String, Object> treeMap(ObjectReference o) {
            List<Object> entries = new ArrayList<>();
            Value size = field(o, "size");
            int n = size instanceof IntegerValue ? ((IntegerValue) size).value() : 0;
            inOrder(field(o, "root"), entries);
            return trim(CwDebugAdapter.obj("kind", "map", "type", "TreeMap", "entries", entries), n, entries.size());
        }

        private void inOrder(Value node, List<Object> out) {
            if (!(node instanceof ObjectReference) || out.size() >= maxItems) return;
            ObjectReference e = (ObjectReference) node;
            inOrder(field(e, "left"), out);
            if (out.size() < maxItems) out.add(List.of(value(field(e, "key")), value(field(e, "value"))));
            inOrder(field(e, "right"), out);
        }

        @SuppressWarnings("unchecked")
        private Map<String, Object> set(ObjectReference o, String name) {
            Value backing = field(o, name.equals("java.util.TreeSet") ? "m" : "map");
            List<Object> items = new ArrayList<>();
            int n = 0;
            if (backing instanceof ObjectReference) {
                ObjectReference map = (ObjectReference) backing;
                String mapType = map.referenceType().name();
                Map<String, Object> m = mapType.equals("java.util.TreeMap") ? treeMap(map) : hashMap(map, mapType);
                for (Object entry : (List<Object>) m.get("entries")) items.add(((List<Object>) entry).get(0));
                Value size = field(map, "size");
                n = size instanceof IntegerValue ? ((IntegerValue) size).value() : items.size();
            }
            return trim(CwDebugAdapter.obj("kind", "sequence", "type", simpleName(name), "items", items), n, items.size());
        }

        private Value field(ObjectReference o, String name) {
            Field f = o.referenceType().fieldByName(name);
            return f == null ? null : o.getValue(f);
        }

        private Map<String, Object> trim(Map<String, Object> obj, long total, long shown) {
            if (total > shown) obj.put("omitted", total - shown);
            return obj;
        }

        private Map<String, Object> inline(String text, String type) {
            return CwDebugAdapter.obj("kind", "value", "text", text, "type", type);
        }

        private String quoted(String s) {
            String shown = s.length() > maxString ? s.substring(0, (int) maxString) + "…" : s;
            return "\"" + escape(shown) + "\"";
        }
    }

    private static boolean isJdk(String name) {
        for (String p : EXCLUDES) if (name.startsWith(p.substring(0, p.length() - 1))) return true;
        return false;
    }

    private static String unbox(ObjectReference o) {
        switch (o.referenceType().name()) {
            case "java.lang.Integer": case "java.lang.Long": case "java.lang.Short": case "java.lang.Byte":
            case "java.lang.Double": case "java.lang.Float": case "java.lang.Boolean": {
                Field f = o.referenceType().fieldByName("value");
                return f == null ? null : String.valueOf(o.getValue(f));
            }
            case "java.lang.Character": {
                Field f = o.referenceType().fieldByName("value");
                return f == null ? null : "'" + escape(String.valueOf(o.getValue(f))) + "'";
            }
            default:
                return null;
        }
    }

    private static String enumConstant(ObjectReference o) {
        ReferenceType t = o.referenceType();
        boolean isEnum = t instanceof ClassType && (((ClassType) t).isEnum()
                || (((ClassType) t).superclass() != null && ((ClassType) t).superclass().isEnum()));
        if (!isEnum) return null;
        for (ClassType c = (ClassType) t; c != null; c = c.superclass()) {
            Field f = c.fieldByName("name");
            if (f != null && c.name().equals("java.lang.Enum")) {
                Value v = o.getValue(f);
                return v instanceof StringReference ? ((StringReference) v).value() : null;
            }
        }
        return null;
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\n", "\\n").replace("\t", "\\t").replace("\"", "\\\"");
    }
}
