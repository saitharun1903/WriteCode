import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/**
 * Code Workspace Java debug adapter.
 *
 * Runs inside the sandbox next to the program. Launches the program in a
 * second JVM through JDI (JDWP over loopback) and speaks newline-delimited
 * JSON on stdin/stdout:
 *
 *   in : {"seq":1,"cmd":"launch", ...} | continue | pause | stepOver | stepIn | stepOut
 *        | setBreakpoints | variables | evaluate | terminate
 *   out: {"type":"response","requestSeq":1,...} | {"type":"event","event":"stopped",...}
 *
 * All data comes from the live target VM. Watch expressions use a small
 * side-effect-free evaluator: it never invokes methods in the target.
 */
public final class CwDebugAdapter {

    // ---------------------------------------------------------------- JSON

    /** Minimal JSON reader/writer so the adapter has no dependencies. */
    static final class Json {
        private final String s;
        private int i;

        private Json(String s) { this.s = s; }

        static Object parse(String s) {
            Json j = new Json(s);
            j.ws();
            Object v = j.value();
            j.ws();
            if (j.i != s.length()) throw new IllegalArgumentException("trailing characters");
            return v;
        }

        private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

        private Object value() {
            char c = s.charAt(i);
            switch (c) {
                case '{': return object();
                case '[': return array();
                case '"': return string();
                case 't': expect("true"); return Boolean.TRUE;
                case 'f': expect("false"); return Boolean.FALSE;
                case 'n': expect("null"); return null;
                default: return number();
            }
        }

        private void expect(String word) {
            if (!s.startsWith(word, i)) throw new IllegalArgumentException("expected " + word);
            i += word.length();
        }

        private Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<>();
            i++; ws();
            if (s.charAt(i) == '}') { i++; return m; }
            while (true) {
                ws();
                String k = string();
                ws();
                if (s.charAt(i++) != ':') throw new IllegalArgumentException("expected :");
                ws();
                m.put(k, value());
                ws();
                char c = s.charAt(i++);
                if (c == '}') return m;
                if (c != ',') throw new IllegalArgumentException("expected , or }");
            }
        }

        private List<Object> array() {
            List<Object> l = new ArrayList<>();
            i++; ws();
            if (s.charAt(i) == ']') { i++; return l; }
            while (true) {
                ws();
                l.add(value());
                ws();
                char c = s.charAt(i++);
                if (c == ']') return l;
                if (c != ',') throw new IllegalArgumentException("expected , or ]");
            }
        }

        private String string() {
            if (s.charAt(i) != '"') throw new IllegalArgumentException("expected string");
            i++;
            StringBuilder b = new StringBuilder();
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') return b.toString();
                if (c == '\\') {
                    char e = s.charAt(i++);
                    switch (e) {
                        case 'n': b.append('\n'); break;
                        case 't': b.append('\t'); break;
                        case 'r': b.append('\r'); break;
                        case 'b': b.append('\b'); break;
                        case 'f': b.append('\f'); break;
                        case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                        default: b.append(e);
                    }
                } else b.append(c);
            }
        }

        private Number number() {
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String n = s.substring(start, i);
            if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
            return Long.parseLong(n);
        }

        static String write(Object v) {
            StringBuilder b = new StringBuilder();
            write(b, v);
            return b.toString();
        }

        @SuppressWarnings("unchecked")
        private static void write(StringBuilder b, Object v) {
            if (v == null) b.append("null");
            else if (v instanceof String) quote(b, (String) v);
            else if (v instanceof Number || v instanceof Boolean) b.append(v);
            else if (v instanceof Map) {
                b.append('{');
                boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
                    if (!first) b.append(',');
                    first = false;
                    quote(b, e.getKey());
                    b.append(':');
                    write(b, e.getValue());
                }
                b.append('}');
            } else if (v instanceof Collection) {
                b.append('[');
                boolean first = true;
                for (Object o : (Collection<Object>) v) {
                    if (!first) b.append(',');
                    first = false;
                    write(b, o);
                }
                b.append(']');
            } else quote(b, v.toString());
        }

        private static void quote(StringBuilder b, String s) {
            b.append('"');
            for (int k = 0; k < s.length(); k++) {
                char c = s.charAt(k);
                switch (c) {
                    case '"': b.append("\\\""); break;
                    case '\\': b.append("\\\\"); break;
                    case '\n': b.append("\\n"); break;
                    case '\r': b.append("\\r"); break;
                    case '\t': b.append("\\t"); break;
                    default:
                        if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                        else b.append(c);
                }
            }
            b.append('"');
        }
    }

    static Map<String, Object> obj(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int k = 0; k < kv.length; k += 2) m.put((String) kv[k], kv[k + 1]);
        return m;
    }

    // ------------------------------------------------------------- state

    private final PrintStream out;
    private final Object writeLock = new Object();
    private VirtualMachine vm;
    private EventRequestManager erm;
    private final List<String> projectFiles = new ArrayList<>();
    /** Project file -> requested breakpoint lines. */
    private final Map<String, Set<Integer>> breakpoints = new ConcurrentHashMap<>();
    /** Installed JDI requests per project file so they can be replaced. */
    private final Map<String, List<BreakpointRequest>> installed = new ConcurrentHashMap<>();
    private final Map<String, ClassPrepareRequest> prepareRequests = new ConcurrentHashMap<>();
    private volatile ThreadReference stoppedThread;
    /** Variable references handed to the client; valid only while suspended. */
    private final Map<Integer, Object> refs = new HashMap<>();
    private int nextRef = 1;
    private volatile boolean terminated;
    private static final String[] EXCLUDES = {"java.*", "javax.*", "sun.*", "jdk.*", "com.sun.*", "kotlin.*"};

    private CwDebugAdapter(PrintStream out) { this.out = out; }

    private void send(Map<String, Object> msg) {
        synchronized (writeLock) {
            out.println(Json.write(msg));
            out.flush();
        }
    }

    private void event(String name, Map<String, Object> body) {
        Map<String, Object> m = obj("type", "event", "event", name);
        m.putAll(body);
        send(m);
    }

    private void respond(Object seq, boolean success, Map<String, Object> body, String error) {
        Map<String, Object> m = obj("type", "response", "requestSeq", seq, "success", success);
        if (body != null) m.putAll(body);
        if (error != null) m.put("message", error);
        send(m);
    }

    // ------------------------------------------------------------- main

    public static void main(String[] args) throws Exception {
        PrintStream stdout = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        CwDebugAdapter a = new CwDebugAdapter(stdout);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) continue;
            Map<String, Object> req;
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> parsed = (Map<String, Object>) Json.parse(line);
                req = parsed;
            } catch (RuntimeException e) {
                a.event("error", obj("message", "invalid request: " + e.getMessage()));
                continue;
            }
            Object seq = req.get("seq");
            try {
                a.handle(req, seq);
            } catch (VMDisconnectedException e) {
                a.respond(seq, false, null, "The program has ended.");
            } catch (Exception e) {
                a.respond(seq, false, null, e.getClass().getSimpleName() + ": " + e.getMessage());
            }
            if (a.terminated) break;
        }
        a.shutdown();
        System.exit(0);
    }

    @SuppressWarnings("unchecked")
    private void handle(Map<String, Object> req, Object seq) throws Exception {
        String cmd = String.valueOf(req.get("cmd"));
        switch (cmd) {
            case "launch": {
                launch(req);
                respond(seq, true, null, null);
                break;
            }
            case "setBreakpoints": {
                String file = (String) req.get("file");
                Set<Integer> lines = new TreeSet<>();
                for (Object o : (List<Object>) req.get("lines")) lines.add(((Number) o).intValue());
                breakpoints.put(file, lines);
                respond(seq, true, obj("file", file, "breakpoints", installBreakpoints(file)), null);
                break;
            }
            case "continue": resume(); respond(seq, true, null, null); break;
            case "pause": {
                requireVm();
                vm.suspend();
                ThreadReference t = mainThread();
                respond(seq, true, null, null);
                stopped(t, "pause", null);
                break;
            }
            case "stepOver": step(StepRequest.STEP_OVER); respond(seq, true, null, null); break;
            case "stepIn": step(StepRequest.STEP_INTO); respond(seq, true, null, null); break;
            case "stepOut": step(StepRequest.STEP_OUT); respond(seq, true, null, null); break;
            case "variables": {
                int ref = ((Number) req.get("ref")).intValue();
                respond(seq, true, obj("ref", ref, "variables", variables(ref)), null);
                break;
            }
            case "evaluate": {
                String expr = (String) req.get("expression");
                int frame = req.get("frame") == null ? 0 : ((Number) req.get("frame")).intValue();
                try {
                    Map<String, Object> v = evaluate(expr, frame);
                    respond(seq, true, obj("expression", expr, "result", v), null);
                } catch (EvalException e) {
                    respond(seq, true, obj("expression", expr, "error", e.getMessage()), null);
                }
                break;
            }
            case "terminate": {
                respond(seq, true, null, null);
                terminated = true;
                break;
            }
            default:
                respond(seq, false, null, "unknown command: " + cmd);
        }
    }

    private void requireVm() {
        if (vm == null) throw new IllegalStateException("program not launched");
    }

    // ------------------------------------------------------------- launch

    @SuppressWarnings("unchecked")
    private void launch(Map<String, Object> req) throws Exception {
        String mainClass = (String) req.get("mainClass");
        String classpath = (String) req.get("classpath");
        String vmOptions = req.get("vmOptions") == null ? "" : (String) req.get("vmOptions");
        String stdinPath = (String) req.get("stdinPath");
        // Optional launcher home whose bin/java wrapper redirects the program's stdin itself.
        String javaHome = (String) req.get("javaHome");
        for (Object f : (List<Object>) req.get("files")) projectFiles.add((String) f);
        Map<String, Object> bps = (Map<String, Object>) req.get("breakpoints");
        if (bps != null) {
            for (Map.Entry<String, Object> e : bps.entrySet()) {
                Set<Integer> lines = new TreeSet<>();
                for (Object o : (List<Object>) e.getValue()) lines.add(((Number) o).intValue());
                breakpoints.put(e.getKey(), lines);
            }
        }

        LaunchingConnector connector = Bootstrap.virtualMachineManager().defaultConnector();
        Map<String, Connector.Argument> cargs = connector.defaultArguments();
        cargs.get("main").setValue(mainClass);
        cargs.get("options").setValue("-cp " + classpath + " " + vmOptions);
        cargs.get("suspend").setValue("true");
        if (javaHome != null) cargs.get("home").setValue(javaHome);
        vm = connector.launch(cargs);
        erm = vm.eventRequestManager();

        Process p = vm.process();
        pump(p.getInputStream(), "stdout");
        pump(p.getErrorStream(), "stderr");
        Thread stdinPump = new Thread(() -> {
            try (OutputStream os = p.getOutputStream()) {
                if (javaHome == null && stdinPath != null && Files.exists(Paths.get(stdinPath))) Files.copy(Paths.get(stdinPath), os);
            } catch (IOException ignored) {
                // The program closed stdin or exited.
            }
        }, "stdin-pump");
        stdinPump.setDaemon(true);
        stdinPump.start();

        // Stop on uncaught exceptions in user code.
        ExceptionRequest exReq = erm.createExceptionRequest(null, false, true);
        for (String ex : EXCLUDES) exReq.addClassExclusionFilter(ex);
        exReq.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        exReq.enable();

        for (String file : breakpoints.keySet()) installBreakpoints(file);

        Thread loop = new Thread(this::eventLoop, "jdi-events");
        loop.setDaemon(true);
        loop.start();
        event("continued", obj());
    }

    private void pump(InputStream is, String stream) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[8192];
            try {
                int n;
                while ((n = is.read(buf)) > 0) {
                    event("output", obj("stream", stream, "text", new String(buf, 0, n, StandardCharsets.UTF_8)));
                }
            } catch (IOException ignored) {
                // Stream closed at exit.
            }
        }, stream + "-pump");
        t.setDaemon(true);
        t.start();
    }

    // -------------------------------------------------------- breakpoints

    private static String basename(String path) {
        int k = path.lastIndexOf('/');
        return k < 0 ? path : path.substring(k + 1);
    }

    /** Maps a JDI source path (e.g. "com/app/Main.java") to a project file. */
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
        String base = basename(sourcePath);
        String match = null;
        for (String f : projectFiles) {
            if (f.equals(base) || f.endsWith("/" + base)) {
                if (match != null) return null;
                match = f;
            }
        }
        return match;
    }

    private boolean typeBelongsTo(ReferenceType type, String file) {
        try {
            String sp = type.sourcePaths(null).isEmpty() ? null : type.sourcePaths(null).get(0);
            if (sp == null) return false;
            if (sp.equals(file)) return true;
            return basename(sp).equals(basename(file)) && (file.endsWith("/" + sp) || !file.contains("/") || sp.endsWith(file));
        } catch (AbsentInformationException e) {
            return false;
        }
    }

    /**
     * (Re)installs breakpoints for a file on every loaded class from it, and
     * arms a class-prepare request so classes loaded later get them too.
     */
    private synchronized List<Object> installBreakpoints(String file) {
        List<Object> result = new ArrayList<>();
        Set<Integer> lines = breakpoints.getOrDefault(file, Collections.emptySet());
        if (vm == null) {
            for (int line : lines) result.add(obj("line", line, "verified", false));
            return result;
        }
        for (BreakpointRequest r : installed.getOrDefault(file, Collections.emptyList())) erm.deleteEventRequest(r);
        installed.put(file, new ArrayList<>());

        if (!prepareRequests.containsKey(file)) {
            ClassPrepareRequest cpr = erm.createClassPrepareRequest();
            cpr.addSourceNameFilter(basename(file));
            cpr.setSuspendPolicy(EventRequest.SUSPEND_ALL);
            cpr.enable();
            prepareRequests.put(file, cpr);
        }

        List<ReferenceType> types = new ArrayList<>();
        for (ReferenceType type : vm.allClasses()) {
            if (typeBelongsTo(type, file)) types.add(type);
        }
        for (int line : lines) {
            // A line with no code of its own (blank, a comment, a brace, a declaration) stops at the next line that has some.
            Integer actual = null;
            for (ReferenceType type : types) {
                Integer at = lineWithCode(type, line);
                if (at != null && (actual == null || at < actual)) actual = at;
            }
            if (actual == null) {
                result.add(obj("line", line, "verified", false));
                continue;
            }
            for (ReferenceType type : types) installOn(type, file, actual);
            result.add(obj("line", line, "verified", true, "actual", actual));
        }
        return result;
    }

    /**
     * The line a breakpoint asked for at `line` stops on in this class: the line
     * itself when it has code, else the next line of the class that has, as long
     * as `line` is inside the class (between its first and last lines with code).
     */
    private Integer lineWithCode(ReferenceType type, int line) {
        try {
            if (!type.locationsOfLine(line).isEmpty()) return line;
            int first = Integer.MAX_VALUE;
            int last = -1;
            Integer next = null;
            for (Location loc : type.allLineLocations()) {
                int l = loc.lineNumber();
                if (l <= 0) continue;
                first = Math.min(first, l);
                last = Math.max(last, l);
                if (l > line && (next == null || l < next)) next = l;
            }
            return last < 0 || line < first || line > last ? null : next;
        } catch (AbsentInformationException e) {
            // Compiled without -g; cannot map lines.
            return null;
        }
    }

    private void installOn(ReferenceType type, String file, int line) {
        try {
            for (Location loc : type.locationsOfLine(line)) {
                BreakpointRequest br = erm.createBreakpointRequest(loc);
                br.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                br.enable();
                installed.computeIfAbsent(file, k -> new ArrayList<>()).add(br);
            }
        } catch (AbsentInformationException ignored) {
            // Compiled without -g; cannot map lines.
        }
    }

    // ------------------------------------------------------------- events

    private void eventLoop() {
        EventQueue queue = vm.eventQueue();
        try {
            while (true) {
                EventSet set = queue.remove();
                boolean resume = true;
                for (Event e : set) {
                    if (e instanceof VMStartEvent) {
                        resume = true;
                    } else if (e instanceof ClassPrepareEvent) {
                        ReferenceType type = ((ClassPrepareEvent) e).referenceType();
                        for (String file : breakpoints.keySet()) {
                            if (!typeBelongsTo(type, file)) continue;
                            // With this class loaded, every breakpoint of the file is placed again on all its classes.
                            event("breakpoints", obj("file", file, "breakpoints", installBreakpoints(file)));
                        }
                    } else if (e instanceof BreakpointEvent) {
                        resume = false;
                        stopped(((BreakpointEvent) e).thread(), "breakpoint", null);
                    } else if (e instanceof StepEvent) {
                        resume = false;
                        erm.deleteEventRequest(e.request());
                        stopped(((StepEvent) e).thread(), "step", null);
                    } else if (e instanceof ExceptionEvent) {
                        resume = false;
                        ExceptionEvent ex = (ExceptionEvent) e;
                        stopped(ex.thread(), "exception", describeException(ex.exception()));
                    } else if (e instanceof VMDeathEvent) {
                        // Let the VM finish exiting; the disconnect event follows.
                        resume = true;
                    } else if (e instanceof VMDisconnectEvent) {
                        finish();
                        return;
                    }
                }
                if (resume) set.resume();
            }
        } catch (InterruptedException | VMDisconnectedException e) {
            finish();
        }
    }

    private String describeException(ObjectReference ex) {
        String text = ex.referenceType().name();
        try {
            Field f = ex.referenceType().fieldByName("detailMessage");
            if (f != null) {
                Value v = ex.getValue(f);
                if (v instanceof StringReference) text += ": " + ((StringReference) v).value();
            }
        } catch (RuntimeException ignored) {
            // Best effort.
        }
        return text;
    }

    private void finish() {
        if (terminated) return;
        Integer code = null;
        try {
            Process p = vm.process();
            if (p != null) code = p.waitFor(2, TimeUnit.SECONDS) ? p.exitValue() : null;
        } catch (Exception ignored) {
            // Unknown exit code.
        }
        // Give output pumps a moment to flush the program's last lines.
        try { Thread.sleep(150); } catch (InterruptedException ignored) { }
        event("exited", obj("exitCode", code));
        terminated = true;
    }

    // ------------------------------------------------------------ control

    private ThreadReference mainThread() {
        for (ThreadReference t : vm.allThreads()) if ("main".equals(t.name())) return t;
        return vm.allThreads().get(0);
    }

    private void resume() {
        requireVm();
        synchronized (refs) { refs.clear(); }
        stoppedThread = null;
        event("continued", obj());
        vm.resume();
    }

    private void step(int depth) {
        requireVm();
        ThreadReference t = stoppedThread;
        if (t == null) throw new IllegalStateException("program is not paused");
        for (StepRequest r : new ArrayList<>(erm.stepRequests())) erm.deleteEventRequest(r);
        StepRequest sr = erm.createStepRequest(t, StepRequest.STEP_LINE, depth);
        for (String ex : EXCLUDES) sr.addClassExclusionFilter(ex);
        sr.addCountFilter(1);
        sr.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        sr.enable();
        resume();
    }

    private void stopped(ThreadReference thread, String reason, String description) {
        stoppedThread = thread;
        synchronized (refs) { refs.clear(); nextRef = 1; }
        List<Object> frames = new ArrayList<>();
        try {
            List<StackFrame> fs = thread.frames();
            for (int k = 0; k < fs.size(); k++) {
                Location loc = fs.get(k).location();
                String file = projectFileFor(loc);
                String name = loc.declaringType().name() + "." + loc.method().name();
                int localsRef = file != null ? register(new FrameRef(thread, k)) : 0;
                frames.add(obj("id", k, "name", name, "file", file, "line", loc.lineNumber(), "localsRef", localsRef));
            }
        } catch (IncompatibleThreadStateException e) {
            // Thread resumed underneath us; report without frames.
        }
        Map<String, Object> body = obj("reason", reason, "thread", thread.name(), "frames", frames);
        if (description != null) body.put("description", description);
        event("stopped", body);
    }

    // ---------------------------------------------------------- variables

    static final class FrameRef {
        final ThreadReference thread;
        final int index;
        FrameRef(ThreadReference t, int i) { thread = t; index = i; }
        StackFrame frame() throws IncompatibleThreadStateException { return thread.frame(index); }
    }

    /** The static fields of a class, shown as one expandable "static" entry per frame. */
    static final class StaticsRef {
        final ReferenceType type;
        StaticsRef(ReferenceType t) { type = t; }
    }

    private static List<Field> staticFields(ReferenceType type) {
        List<Field> out = new ArrayList<>();
        for (Field f : type.allFields()) if (f.isStatic() && !f.isSynthetic()) out.add(f);
        return out;
    }

    private int register(Object target) {
        synchronized (refs) {
            int id = nextRef++;
            refs.put(id, target);
            return id;
        }
    }

    private static final int MAX_CHILDREN = 200;

    private List<Object> variables(int ref) throws Exception {
        Object target;
        synchronized (refs) { target = refs.get(ref); }
        if (target == null) throw new IllegalStateException("variable reference expired; the program has resumed");
        List<Object> vars = new ArrayList<>();
        if (target instanceof FrameRef) {
            StackFrame frame = ((FrameRef) target).frame();
            ObjectReference self = frame.thisObject();
            if (self != null) vars.add(describe("this", self));
            try {
                for (LocalVariable lv : frame.visibleVariables()) vars.add(describe(lv.name(), frame.getValue(lv)));
            } catch (AbsentInformationException e) {
                vars.add(obj("name", "(locals unavailable)", "value", "compiled without debug info", "type", "", "ref", 0));
            }
            ReferenceType declaring = frame.location().declaringType();
            List<Field> statics = staticFields(declaring);
            if (!statics.isEmpty()) {
                vars.add(obj("name", "static", "value", simpleName(declaring.name()) + " (" + statics.size() + " field" + (statics.size() == 1 ? "" : "s") + ")",
                        "type", declaring.name(), "ref", register(new StaticsRef(declaring))));
            }
        } else if (target instanceof StaticsRef) {
            ReferenceType type = ((StaticsRef) target).type;
            for (Field f : staticFields(type)) {
                if (vars.size() >= MAX_CHILDREN) break;
                vars.add(describe(f.name(), type.getValue(f)));
            }
        } else if (target instanceof ArrayReference) {
            ArrayReference arr = (ArrayReference) target;
            int n = Math.min(arr.length(), MAX_CHILDREN);
            List<Value> values = n == 0 ? Collections.emptyList() : arr.getValues(0, n);
            for (int k = 0; k < n; k++) vars.add(describe("[" + k + "]", values.get(k)));
            if (arr.length() > n) vars.add(obj("name", "…", "value", (arr.length() - n) + " more", "type", "", "ref", 0));
        } else if (target instanceof ObjectReference) {
            ObjectReference o = (ObjectReference) target;
            List<Value> listItems = listElements(o);
            if (listItems != null) {
                for (int k = 0; k < listItems.size(); k++) vars.add(describe("[" + k + "]", listItems.get(k)));
            }
            for (Field f : o.referenceType().allFields()) {
                if (f.isStatic()) continue;
                if (vars.size() >= MAX_CHILDREN) break;
                vars.add(describe(f.name(), o.getValue(f)));
            }
        }
        return vars;
    }

    /** ArrayList and friends store elements in a backing array; surface them by index. */
    private List<Value> listElements(ObjectReference o) {
        String type = o.referenceType().name();
        if (!type.equals("java.util.ArrayList") && !type.equals("java.util.Vector") && !type.equals("java.util.Stack")) return null;
        Field data = o.referenceType().fieldByName("elementData");
        Field size = o.referenceType().fieldByName(type.equals("java.util.ArrayList") ? "size" : "elementCount");
        if (data == null || size == null) return null;
        Value arr = o.getValue(data);
        Value sz = o.getValue(size);
        if (!(arr instanceof ArrayReference) || !(sz instanceof IntegerValue)) return null;
        int n = Math.min(((IntegerValue) sz).value(), MAX_CHILDREN);
        return n == 0 ? Collections.emptyList() : ((ArrayReference) arr).getValues(0, n);
    }

    private Map<String, Object> describe(String name, Value v) {
        Map<String, Object> d = format(v);
        d.put("name", name);
        return d;
    }

    private Map<String, Object> format(Value v) {
        if (v == null) return obj("value", "null", "type", "null", "ref", 0);
        Type t = v.type();
        if (v instanceof CharValue) return obj("value", "'" + escape(String.valueOf(((CharValue) v).value())) + "'", "type", "char", "ref", 0);
        if (v instanceof PrimitiveValue) return obj("value", v.toString(), "type", t.name(), "ref", 0);
        if (v instanceof StringReference) {
            String s = ((StringReference) v).value();
            String shown = s.length() > 500 ? s.substring(0, 500) + "…" : s;
            return obj("value", "\"" + escape(shown) + "\"", "type", "String", "ref", 0);
        }
        if (v instanceof ArrayReference) {
            ArrayReference a = (ArrayReference) v;
            String elem = t.name().replace("[]", "");
            return obj("value", elem + "[" + a.length() + "]", "type", t.name(), "ref", register(a), "length", a.length());
        }
        ObjectReference o = (ObjectReference) v;
        String type = o.referenceType().name();
        String boxed = unbox(o);
        if (boxed != null) return obj("value", boxed, "type", simpleName(type), "ref", 0);
        List<Value> list = listElements(o);
        String summary = list != null ? simpleName(type) + " (size " + list.size() + ")" : simpleName(type) + "@" + o.uniqueID();
        return obj("value", summary, "type", type, "ref", register(o));
    }

    private static String simpleName(String type) {
        String s = type.substring(type.lastIndexOf('.') + 1);
        int d = s.lastIndexOf('$');
        // Nested classes by their source name (Main$Node -> Node); anonymous ones (Main$1) keep theirs.
        return d >= 0 && d + 1 < s.length() && !Character.isDigit(s.charAt(d + 1)) ? s.substring(d + 1) : s;
    }

    private static String unbox(ObjectReference o) {
        String type = o.referenceType().name();
        switch (type) {
            case "java.lang.Integer": case "java.lang.Long": case "java.lang.Short": case "java.lang.Byte":
            case "java.lang.Double": case "java.lang.Float": case "java.lang.Boolean": case "java.lang.Character": {
                Field f = o.referenceType().fieldByName("value");
                return f == null ? null : String.valueOf(o.getValue(f));
            }
            default: return null;
        }
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\n", "\\n").replace("\t", "\\t").replace("\"", "\\\"");
    }

    // ---------------------------------------------------------- evaluate

    static final class EvalException extends Exception {
        EvalException(String m) { super(m); }
    }

    private Map<String, Object> evaluate(String expr, int frameIndex) throws Exception {
        ThreadReference t = stoppedThread;
        if (t == null) throw new EvalException("Pause the program to evaluate.");
        StackFrame frame = t.frame(frameIndex);
        Object result = new Evaluator(expr, frame, vm).evaluate();
        if (result instanceof Value || result == null) return format((Value) result);
        if (result instanceof String) return obj("value", "\"" + escape((String) result) + "\"", "type", "String", "ref", 0);
        if (result instanceof Character) return obj("value", "'" + result + "'", "type", "char", "ref", 0);
        String type = result instanceof Boolean ? "boolean" : result instanceof Double ? "double" : "long";
        return obj("value", String.valueOf(result), "type", type, "ref", 0);
    }

    /**
     * Recursive-descent evaluator for watch expressions. Supports literals,
     * locals, fields (incl. `this`), static fields of the current class,
     * array indexing, `.length`, unary - and !, arithmetic, comparisons and
     * logical operators. Never invokes code in the target VM.
     */
    static final class Evaluator {
        private final String src;
        private int p;
        private final StackFrame frame;
        private final VirtualMachine vm;

        Evaluator(String src, StackFrame frame, VirtualMachine vm) {
            this.src = src;
            this.frame = frame;
            this.vm = vm;
        }

        Object evaluate() throws Exception {
            if (src.length() > 500) throw new EvalException("Expression too long.");
            Object v = or();
            skip();
            if (p != src.length()) throw new EvalException("Unexpected '" + src.substring(p) + "'");
            return v;
        }

        private void skip() { while (p < src.length() && Character.isWhitespace(src.charAt(p))) p++; }

        private boolean eat(String tok) {
            skip();
            if (src.startsWith(tok, p)) {
                // Do not treat "<=" as "<" followed by "=", etc.
                if ((tok.equals("<") || tok.equals(">") || tok.equals("=") || tok.equals("!")) && p + 1 < src.length() && src.charAt(p + 1) == '=') return false;
                p += tok.length();
                return true;
            }
            return false;
        }

        private Object or() throws Exception {
            Object l = and();
            while (eat("||")) { Object r = and(); l = bool(l) || bool(r); }
            return l;
        }

        private Object and() throws Exception {
            Object l = equality();
            while (eat("&&")) { Object r = equality(); l = bool(l) && bool(r); }
            return l;
        }

        private Object equality() throws Exception {
            Object l = relational();
            while (true) {
                if (eat("==")) l = equal(l, relational());
                else if (eat("!=")) l = !equal(l, relational());
                else return l;
            }
        }

        private Object relational() throws Exception {
            Object l = additive();
            while (true) {
                if (eat("<=")) l = cmp(l, additive()) <= 0;
                else if (eat(">=")) l = cmp(l, additive()) >= 0;
                else if (eat("<")) l = cmp(l, additive()) < 0;
                else if (eat(">")) l = cmp(l, additive()) > 0;
                else return l;
            }
        }

        private Object additive() throws Exception {
            Object l = multiplicative();
            while (true) {
                if (eat("+")) {
                    Object r = multiplicative();
                    if (isString(l) || isString(r)) l = str(l) + str(r);
                    else l = arith(l, r, '+');
                } else if (eat("-")) l = arith(l, multiplicative(), '-');
                else return l;
            }
        }

        private Object multiplicative() throws Exception {
            Object l = unary();
            while (true) {
                if (eat("*")) l = arith(l, unary(), '*');
                else if (eat("/")) l = arith(l, unary(), '/');
                else if (eat("%")) l = arith(l, unary(), '%');
                else return l;
            }
        }

        private Object unary() throws Exception {
            if (eat("-")) return arith(0L, unary(), '-');
            if (eat("!")) return !bool(unary());
            return postfix(primary());
        }

        private Object postfix(Object v) throws Exception {
            while (true) {
                skip();
                if (eat("[")) {
                    Object idx = or();
                    if (!eat("]")) throw new EvalException("Expected ]");
                    Object target = unwrap(v);
                    if (!(target instanceof ArrayReference)) throw new EvalException("Not an array.");
                    ArrayReference arr = (ArrayReference) target;
                    long k = num(idx).longValue();
                    if (k < 0 || k >= arr.length()) throw new EvalException("Index " + k + " out of bounds for length " + arr.length());
                    v = arr.getValue((int) k);
                } else if (eat(".")) {
                    String name = ident();
                    Object target = unwrap(v);
                    if (target instanceof ArrayReference && name.equals("length")) {
                        v = (long) ((ArrayReference) target).length();
                    } else if (target instanceof ObjectReference) {
                        ObjectReference o = (ObjectReference) target;
                        Field f = o.referenceType().fieldByName(name);
                        if (f == null) throw new EvalException("No field '" + name + "' on " + o.referenceType().name());
                        v = o.getValue(f);
                    } else throw new EvalException("Cannot read '" + name + "' of " + str(v));
                    skip();
                    if (p < src.length() && src.charAt(p) == '(') throw new EvalException("Method calls are not supported in watch expressions.");
                } else return v;
            }
        }

        private Object primary() throws Exception {
            skip();
            if (p >= src.length()) throw new EvalException("Unexpected end of expression.");
            char c = src.charAt(p);
            if (c == '(') {
                p++;
                Object v = or();
                if (!eat(")")) throw new EvalException("Expected )");
                return v;
            }
            if (Character.isDigit(c)) return numberLiteral();
            if (c == '"') {
                int end = src.indexOf('"', p + 1);
                if (end < 0) throw new EvalException("Unterminated string.");
                String s = src.substring(p + 1, end);
                p = end + 1;
                return s;
            }
            if (c == '\'' && p + 2 < src.length() && src.charAt(p + 2) == '\'') {
                char ch = src.charAt(p + 1);
                p += 3;
                return ch;
            }
            String name = ident();
            switch (name) {
                case "true": return Boolean.TRUE;
                case "false": return Boolean.FALSE;
                case "null": return null;
                case "this": {
                    ObjectReference self = frame.thisObject();
                    if (self == null) throw new EvalException("'this' is not available in a static method.");
                    return self;
                }
                default: return lookup(name);
            }
        }

        private Object lookup(String name) throws Exception {
            try {
                LocalVariable lv = frame.visibleVariableByName(name);
                if (lv != null) return frame.getValue(lv);
            } catch (AbsentInformationException ignored) {
                // Fall through to fields.
            }
            ObjectReference self = frame.thisObject();
            ReferenceType type = frame.location().declaringType();
            Field f = type.fieldByName(name);
            if (f != null) {
                if (f.isStatic()) return type.getValue(f);
                if (self != null) return self.getValue(f);
            }
            throw new EvalException("Unknown name '" + name + "'");
        }

        private String ident() throws EvalException {
            skip();
            int start = p;
            while (p < src.length() && (Character.isJavaIdentifierPart(src.charAt(p)))) p++;
            if (start == p) throw new EvalException("Unexpected '" + src.substring(p) + "'");
            return src.substring(start, p);
        }

        private Object numberLiteral() {
            int start = p;
            while (p < src.length() && (Character.isDigit(src.charAt(p)) || src.charAt(p) == '.' || src.charAt(p) == '_')) p++;
            String n = src.substring(start, p).replace("_", "");
            if (p < src.length() && "LlDdFf".indexOf(src.charAt(p)) >= 0) p++;
            return n.contains(".") ? (Object) Double.parseDouble(n) : (Object) Long.parseLong(n);
        }

        // --- value helpers

        private static Object unwrap(Object v) {
            if (v instanceof BooleanValue) return ((BooleanValue) v).value();
            if (v instanceof CharValue) return ((CharValue) v).value();
            if (v instanceof DoubleValue || v instanceof FloatValue) return ((PrimitiveValue) v).doubleValue();
            if (v instanceof PrimitiveValue) return ((PrimitiveValue) v).longValue();
            if (v instanceof StringReference) return ((StringReference) v).value();
            if (v instanceof ObjectReference) {
                String boxed = unbox((ObjectReference) v);
                if (boxed != null) {
                    String type = ((ObjectReference) v).referenceType().name();
                    if (type.endsWith("Boolean")) return Boolean.parseBoolean(boxed);
                    if (type.endsWith("Double") || type.endsWith("Float")) return Double.parseDouble(boxed);
                    if (type.endsWith("Character")) return boxed.charAt(0);
                    return Long.parseLong(boxed);
                }
            }
            return v;
        }

        private static boolean isString(Object v) { return unwrap(v) instanceof String; }

        private static String str(Object v) {
            Object u = unwrap(v);
            if (u == null) return "null";
            if (u instanceof ObjectReference) return simpleName(((ObjectReference) u).referenceType().name()) + "@" + ((ObjectReference) u).uniqueID();
            return String.valueOf(u);
        }

        private static Number num(Object v) throws EvalException {
            Object u = unwrap(v);
            if (u instanceof Character) return (long) (Character) u;
            if (u instanceof Number) return (Number) u;
            throw new EvalException("Expected a number, got " + str(v));
        }

        private static boolean bool(Object v) throws EvalException {
            Object u = unwrap(v);
            if (u instanceof Boolean) return (Boolean) u;
            throw new EvalException("Expected a boolean, got " + str(v));
        }

        private static Object arith(Object a, Object b, char op) throws EvalException {
            Number x = num(a), y = num(b);
            if (x instanceof Double || y instanceof Double) {
                double l = x.doubleValue(), r = y.doubleValue();
                switch (op) {
                    case '+': return l + r;
                    case '-': return l - r;
                    case '*': return l * r;
                    case '/': return l / r;
                    default: return l % r;
                }
            }
            long l = x.longValue(), r = y.longValue();
            switch (op) {
                case '+': return l + r;
                case '-': return l - r;
                case '*': return l * r;
                case '/': if (r == 0) throw new EvalException("Division by zero."); return l / r;
                default: if (r == 0) throw new EvalException("Division by zero."); return l % r;
            }
        }

        private static int cmp(Object a, Object b) throws EvalException {
            return Double.compare(num(a).doubleValue(), num(b).doubleValue());
        }

        private static boolean equal(Object a, Object b) throws EvalException {
            Object x = unwrap(a), y = unwrap(b);
            if (x == null || y == null) return x == y;
            if (x instanceof Number || x instanceof Character) {
                if (y instanceof Number || y instanceof Character) return num(x).doubleValue() == num(y).doubleValue();
                return false;
            }
            return x.equals(y);
        }
    }

    // ----------------------------------------------------------- shutdown

    private void shutdown() {
        if (vm == null) return;
        try {
            vm.exit(143);
        } catch (Exception ignored) {
            // Already gone.
        }
        try {
            vm.dispose();
        } catch (Exception ignored) {
            // Already gone.
        }
    }
}
