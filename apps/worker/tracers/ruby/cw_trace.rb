# frozen_string_literal: true

# Code Workspace Ruby execution tracer (visualizer).
#
# Runs the program in this interpreter under a TracePoint and records, for
# every line executed in a project file, the call stack with each frame's
# variables and every object reachable from them. Writes the trace as JSON
# when the program ends. Stdin, stdout and stderr are the program's own; what
# it prints is counted (and kept) on the way out, so output appears exactly as
# in a normal run.
#
#     ruby cw_trace.rb <config.json>
#
# config: {"entry", "root", "files", "out", "limits": {...}}
#
# Objects are read with the core classes' own methods (Array#first,
# Hash#first, instance_variable_get), never with the program's overrides of
# inspect, to_s or each, so recording cannot change what the program does.
# Code run inside a TracePoint hook is not traced itself.

require "json"

module CwTrace
  NONE = Object.new

  BIND = ->(owner, name) { owner.instance_method(name) }
  OBJECT_ID = BIND.(BasicObject, :__id__)
  CLASS_OF = BIND.(Kernel, :class)
  IVARS = BIND.(Kernel, :instance_variables)
  IVAR_GET = BIND.(Kernel, :instance_variable_get)
  MODULE_NAME = BIND.(Module, :name)
  STRING_INSPECT = BIND.(String, :inspect)
  ARRAY_FIRST = BIND.(Array, :first)
  ARRAY_SIZE = BIND.(Array, :size)
  HASH_FIRST = BIND.(Hash, :first)
  HASH_SIZE = BIND.(Hash, :size)
  STRUCT_MEMBERS = BIND.(Struct, :members)
  STRUCT_VALUES = BIND.(Struct, :to_a)
  EXCEPTION_MESSAGE = BIND.(Exception, :message)

  def self.class_name(v)
    c = CLASS_OF.bind_call(v)
    MODULE_NAME.bind_call(c) || c.to_s
  rescue StandardError
    "Object"
  end

  # Counts (and keeps) what the program writes to stdout. IO#puts, #print and
  # #<< call an overridden #write, so every way of printing passes through here.
  class CountingIO < IO
    attr_reader :count, :kept

    def setup(keep)
      @count = 0
      @kept = +""
      @keep = keep
      self
    end

    def write(*args)
      text = args.map { |a| a.is_a?(String) ? a : a.to_s }.join
      @count += text.length
      if @keep.positive?
        @kept << text[0, @keep]
        @keep -= text.length
      end
      super
    end
  end

  # Turns values into trace values, adding reachable objects to the step's heap breadth-first.
  class Encoder
    def initialize(heap, limits)
      @heap = heap
      @limits = limits
      @queue = []
    end

    def value(v)
      case v
      when nil then { kind: "value", text: "nil", type: "NilClass" }
      when true, false then { kind: "value", text: v.to_s, type: v ? "TrueClass" : "FalseClass" }
      when Integer, Float then { kind: "value", text: CwTrace.class_name(v) == "Integer" ? Integer.instance_method(:to_s).bind_call(v) : Float.instance_method(:to_s).bind_call(v), type: CwTrace.class_name(v) }
      when Symbol then { kind: "value", text: Symbol.instance_method(:inspect).bind_call(v), type: "Symbol" }
      when String then { kind: "value", text: string(v), type: "String" }
      when Rational, Complex then { kind: "value", text: v.to_s, type: CwTrace.class_name(v) }
      when Range
        ends = [v.begin, v.end]
        if ends.all? { |e| e.nil? || e.is_a?(Integer) || e.is_a?(String) }
          { kind: "value", text: "#{ends[0].inspect unless ends[0].nil?}#{v.exclude_end? ? '...' : '..'}#{ends[1].inspect unless ends[1].nil?}", type: "Range" }
        else
          ref(v)
        end
      else ref(v)
      end
    end

    def string(v)
      max = @limits["maxStringChars"]
      s = String.instance_method(:scrub).bind_call(v)
      s.length > max ? "#{STRING_INSPECT.bind_call(s[0, max])}…" : STRING_INSPECT.bind_call(s)
    end

    def ref(v)
      id = OBJECT_ID.bind_call(v).to_s
      unless @heap.key?(id)
        if @heap.size >= @limits["maxObjectsPerStep"]
          name = CwTrace.class_name(v)
          return { kind: "value", text: "#<#{name}>", type: name }
        end
        @heap[id] = nil # reserved; filled by drain
        @queue << [id, v]
      end
      { kind: "ref", id: id }
    end

    def drain
      until @queue.empty?
        id, v = @queue.shift
        @heap[id] = describe(v)
      end
    end

    def describe(v)
      cap = @limits["maxItemsPerObject"]
      type = CwTrace.class_name(v)
      case v
      when Array
        items = ARRAY_FIRST.bind_call(v, cap)
        trim({ kind: "sequence", type: type, items: items.map { |x| value(x) } }, ARRAY_SIZE.bind_call(v), items.size)
      when Hash
        pairs = HASH_FIRST.bind_call(v, cap)
        trim({ kind: "map", type: type, entries: pairs.map { |k, x| [value(k), value(x)] } }, HASH_SIZE.bind_call(v), pairs.size)
      when Struct
        names = STRUCT_MEMBERS.bind_call(v)
        values = STRUCT_VALUES.bind_call(v)
        { kind: "object", type: type, fields: names.first(cap).each_with_index.map { |n, i| [n.to_s, value(values[i])] } }
      when Proc then { kind: "other", type: "Proc", text: v.lambda? ? "lambda" : "proc" }
      when Method, UnboundMethod then { kind: "other", type: "Method", text: "method #{v.name}" }
      when Module then { kind: "other", type: v.is_a?(Class) ? "Class" : "Module", text: "#{v.is_a?(Class) ? 'class' : 'module'} #{MODULE_NAME.bind_call(v)}" }
      when Exception then { kind: "object", type: type, fields: [["message", value(EXCEPTION_MESSAGE.bind_call(v))]] }
      when Range then { kind: "object", type: "Range", fields: [["begin", value(v.begin)], ["end", value(v.end)]] }
      else
        if defined?(::Set) && v.is_a?(::Set)
          hash = IVAR_GET.bind_call(v, :@hash)
          if hash.is_a?(Hash)
            keys = HASH_FIRST.bind_call(hash, cap).map(&:first)
            return trim({ kind: "sequence", type: type, items: keys.map { |x| value(x) } }, HASH_SIZE.bind_call(hash), keys.size)
          end
        end
        if defined?(::Data) && v.is_a?(::Data)
          h = ::Data.instance_method(:to_h).bind_call(v)
          return { kind: "object", type: type, fields: HASH_FIRST.bind_call(h, cap).map { |k, x| [k.to_s, value(x)] } }
        end
        names = IVARS.bind_call(v)
        return { kind: "other", type: type, text: "#<#{type}>" } if names.empty?

        shown = names.first(cap)
        trim({ kind: "object", type: type, fields: shown.map { |n| [n.to_s.delete_prefix("@"), value(IVAR_GET.bind_call(v, n))] } }, names.size, shown.size)
      end
    rescue StandardError => e
      { kind: "other", type: type || "Object", text: "(could not be read: #{e.class})" }
    end

    def trim(obj, total, shown)
      obj[:omitted] = total - shown if total > shown
      obj
    end
  end

  class Tracer
    attr_reader :stdout

    def initialize(config)
      @root = File.expand_path(config["root"])
      @files = config["files"].to_h { |f| [f, true] }
      @limits = config["limits"]
      @steps = []
      @size = 0
      @truncated = nil
      @done = false
      @paths = {}
      # Every Ruby frame (methods, blocks, class bodies, and a file's top level), outermost first;
      # nil for a frame outside the project.
      @stack = []
      @main = TOPLEVEL_BINDING.receiver
    end

    def project(path)
      return nil if path.nil?

      @paths.fetch(path) do
        rel = File.expand_path(path, @root).delete_prefix("#{@root}/")
        @paths[path] = @files.key?(rel) ? rel : nil
      end
    end

    def start(stdout)
      @stdout = stdout
      @tp = TracePoint.new(:line, :call, :return, :b_call, :b_return, :class, :end, :raise) { |tp| on(tp) }
      @tp.enable(target_thread: Thread.current)
    end

    def stop(reason = nil)
      return if @done

      @done = true
      @truncated = reason
      @tp&.disable
    end

    def on(tp)
      return if @done

      case tp.event
      when :call, :b_call, :class then push(tp)
      when :return, :b_return, :end
        entry = @stack.last
        record("return", return_value: tp.return_value) if entry && tp.event != :end
        @stack.pop
      when :line then line(tp)
      when :raise
        record("exception", exception: "#{CwTrace.class_name(tp.raised_exception)}: #{EXCEPTION_MESSAGE.bind_call(tp.raised_exception)}") if project(tp.path) && @stack.last
      end
    rescue StandardError => e
      stop("Recording stopped: #{e.class}: #{e.message}")
    end

    def push(tp)
      file = project(tp.path)
      unless file
        @stack << nil
        return
      end
      b = tp.binding
      entry = { name: frame_name(tp), file: file, binding: b, line: tp.lineno, self: tp.self, method: tp.event == :call }
      if tp.event == :b_call
        # A block sees the variables around it; it is shown with only its own.
        outer = @stack.reverse_each.find { |e| e }
        entry[:hide] = outer ? outer[:binding].local_variables : []
      end
      @stack << entry
    end

    def line(tp)
      file = project(tp.path)
      return unless file

      # A required file's top level has no call event: it begins with its first line and ends when another file's line runs.
      @stack.pop while @stack.last && @stack.last[:required] && @stack.last[:file] != file
      top = @stack.last
      if top.nil? || top[:file] != file
        main = @stack.empty?
        top = { name: main ? "<main>" : "<top (required)>", file: file, required: !main, self: tp.self }
        @stack << top
      end
      top[:binding] = tp.binding
      top[:line] = tp.lineno
      record("line")
    end

    def frame_name(tp)
      case tp.event
      when :class then "<class:#{MODULE_NAME.bind_call(tp.self).to_s.split('::').last}>"
      when :b_call then "block in #{tp.method_id || '<main>'}"
      else
        owner = tp.defined_class
        if owner.nil? || owner == Object then tp.method_id.to_s
        elsif owner.singleton_class? then "#{MODULE_NAME.bind_call(tp.self) || tp.self}.#{tp.method_id}"
        else "#{MODULE_NAME.bind_call(owner)}##{tp.method_id}"
        end
      end
    end

    def locals(entry)
      b = entry[:binding]
      return [] unless b

      names = b.local_variables - (entry[:hide] || [])
      out = names.map { |n| [n.to_s, b.local_variable_get(n)] }
      out.unshift(["self", entry[:self]]) if entry[:method] && !entry[:self].equal?(@main)
      out
    end

    def record(event, return_value: NONE, exception: nil)
      if @steps.size >= @limits["maxSteps"]
        stop("Recording stopped after #{@limits['maxSteps']} steps; the program continued without recording.")
        return
      end
      entries = @stack.compact.select { |e| e[:binding] }
      return if entries.empty?

      heap = {}
      enc = Encoder.new(heap, @limits)
      frames = entries.map do |e|
        { name: e[:name], file: e[:file], line: e[:line], locals: locals(e).map { |k, v| [k, enc.value(v)] } }
      end
      frames.last[:returnValue] = enc.value(return_value) unless return_value.equal?(NONE)
      enc.drain
      step = { event: event, frames: frames, heap: heap, stdoutLength: @stdout ? @stdout.count : 0 }
      step[:exception] = exception if exception
      text = JSON.generate(step)
      @size += text.bytesize + 1
      if @size > @limits["maxTraceBytes"]
        stop("Recording stopped because the trace grew too large; the program continued without recording.")
        return
      end
      @steps << text
    end

    # The main file has no return event: its end is a step of its own, so what its last line printed is in the trace.
    def finish
      record("return") unless @done
      stop
    end

    def write(path)
      head = { language: "ruby", stdout: @stdout ? @stdout.kept : "" }
      head[:truncated] = @truncated if @truncated
      File.open(path, "w") do |f|
        f.write(JSON.generate(head)[0..-2])
        f.write(',"steps":[')
        f.write(@steps.join(","))
        f.write("]}")
      end
    end
  end

  # The backtrace as a normal run prints it: the program's own lines, not the tracer's.
  def self.report(error, root)
    here = File.expand_path(__FILE__)
    kept = (error.backtrace || []).reject { |l| l.start_with?(here) || l.start_with?("#{root}/#{File.basename(here)}") }
    error.set_backtrace(kept.map { |l| l.delete_prefix("#{root}/") })
    $stderr.write(error.full_message(highlight: false, order: :top))
  end

  def self.main
    config = JSON.parse(File.read(ARGV[0]))
    tracer = Tracer.new(config)
    Dir.chdir(tracer.instance_variable_get(:@root))
    entry = config["entry"]
    ARGV.clear
    $0 = entry
    $stderr.sync = true
    out = CountingIO.new(STDOUT.fileno, "w", autoclose: false).setup(1_000_000)
    out.sync = true
    $stdout = out

    code = 0
    tracer.start(out)
    begin
      load entry
      tracer.finish
    rescue SystemExit => e
      code = e.status
    rescue Exception => e # rubocop:disable Lint/RescueException -- the program's own uncaught exception
      tracer.stop
      report(e, Dir.pwd)
      code = 1
    ensure
      tracer.stop
    end
    tracer.write(config["out"])
    $stdout.flush
    exit(code)
  end
end

CwTrace.main
