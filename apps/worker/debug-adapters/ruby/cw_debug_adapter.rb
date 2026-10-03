# frozen_string_literal: true

# Code Workspace Ruby debug adapter.
#
# Runs inside the sandbox and executes the program in this same interpreter
# under a TracePoint. It speaks newline-delimited JSON on the original
# stdin/stdout, the same protocol as the Python and Java adapters:
#
#   in : {"seq":1,"cmd":"launch", ...} | continue | pause | stepOver | stepIn | stepOut
#        | setBreakpoints | variables | evaluate | terminate
#   out: {"type":"response","requestSeq":1,...} | {"type":"event","event":"stopped",...}
#
# The program gets its own stdin (the run's input file or the typed-input
# FIFO); its stdout and stderr are pipes relayed as "output" events, so its
# output never mixes with the protocol. Inspecting values never runs program
# code: values are read with the core classes' own methods, and watch
# expressions are evaluated by a small interpreter that refuses calls into
# the program's methods.

require "json"
require "io/wait"
require "monitor"

module CwDebug
  MAX_CHILDREN = 200
  PREVIEW_ITEMS = 10
  PREVIEW_CHARS = 200
  THREAD_NAME = "main"

  BIND = ->(owner, name) { owner.instance_method(name) }
  OBJECT_ID = BIND.(BasicObject, :__id__)
  CLASS_OF = BIND.(Kernel, :class)
  IVARS = BIND.(Kernel, :instance_variables)
  IVAR_GET = BIND.(Kernel, :instance_variable_get)
  IVAR_DEFINED = BIND.(Kernel, :instance_variable_defined?)
  MODULE_NAME = BIND.(Module, :name)
  STRING_INSPECT = BIND.(String, :inspect)
  ARRAY_FIRST = BIND.(Array, :first)
  ARRAY_SIZE = BIND.(Array, :size)
  HASH_FIRST = BIND.(Hash, :first)
  HASH_SIZE = BIND.(Hash, :size)
  STRUCT_MEMBERS = BIND.(Struct, :members)
  STRUCT_VALUES = BIND.(Struct, :to_a)
  EXCEPTION_MESSAGE = BIND.(Exception, :message)

  class EvalError < StandardError; end

  # ------------------------------------------------------------ values

  module Values
    module_function

    def class_name(v)
      c = CLASS_OF.bind_call(v)
      MODULE_NAME.bind_call(c) || c.to_s
    rescue StandardError
      "Object"
    end

    def core?(v, *classes)
      classes.include?(CLASS_OF.bind_call(v))
    end

    def set?(v)
      defined?(::Set) && v.is_a?(::Set) && IVAR_GET.bind_call(v, :@hash).is_a?(Hash)
    end

    def set_items(v, limit)
      HASH_FIRST.bind_call(IVAR_GET.bind_call(v, :@hash), limit).map(&:first)
    end

    def set_size(v)
      HASH_SIZE.bind_call(IVAR_GET.bind_call(v, :@hash))
    end

    def scalar(v)
      case v
      when nil then "nil"
      when true, false then v.to_s
      when Integer then Integer.instance_method(:to_s).bind_call(v)
      when Float then Float.instance_method(:to_s).bind_call(v)
      when Symbol then Symbol.instance_method(:inspect).bind_call(v)
      when Rational, Complex then v.to_s
      when String
        s = String.instance_method(:scrub).bind_call(v)
        s.length > 500 ? "#{STRING_INSPECT.bind_call(s[0, 500])}…" : STRING_INSPECT.bind_call(s)
      end
    end

    def preview(v, depth = 0)
      s = scalar(v)
      unless s.nil?
        return s.length > 60 && depth.positive? ? "#{s[0, 60]}…" : s
      end

      case v
      when Array
        return "[…]" if depth >= 2

        n = ARRAY_SIZE.bind_call(v)
        parts = ARRAY_FIRST.bind_call(v, PREVIEW_ITEMS).map { |x| preview(x, depth + 1) }
        parts << "…" if n > PREVIEW_ITEMS
        "[#{parts.join(', ')}]"
      when Hash
        return "{…}" if depth >= 2

        n = HASH_SIZE.bind_call(v)
        parts = HASH_FIRST.bind_call(v, PREVIEW_ITEMS).map do |k, x|
          k.is_a?(Symbol) ? "#{k}: #{preview(x, depth + 1)}" : "#{preview(k, depth + 1)} => #{preview(x, depth + 1)}"
        end
        parts << "…" if n > PREVIEW_ITEMS
        "{#{parts.join(', ')}}"
      when Range then "#{preview(v.begin, depth + 1) unless v.begin.nil?}#{v.exclude_end? ? '...' : '..'}#{preview(v.end, depth + 1) unless v.end.nil?}"
      when Struct
        return "#<struct #{class_name(v)}>" if depth >= 1

        names = STRUCT_MEMBERS.bind_call(v)
        values = STRUCT_VALUES.bind_call(v)
        "#<struct #{class_name(v)} #{names.first(PREVIEW_ITEMS).each_with_index.map { |n, i| "#{n}=#{preview(values[i], depth + 1)}" }.join(', ')}>"
      when Module then MODULE_NAME.bind_call(v) || v.to_s
      when Proc then v.lambda? ? "#<lambda>" : "#<proc>"
      when Method, UnboundMethod then "#<method #{v.name}>"
      when Exception then "#<#{class_name(v)}: #{preview(EXCEPTION_MESSAGE.bind_call(v), depth + 1)}>"
      else
        if set?(v)
          return "#<Set: {…}>" if depth >= 2

          items = set_items(v, PREVIEW_ITEMS).map { |x| preview(x, depth + 1) }
          items << "…" if set_size(v) > PREVIEW_ITEMS
          return "#<Set: {#{items.join(', ')}}>"
        end
        name = class_name(v)
        return "#<#{name}>" if depth >= 1

        ivars = IVARS.bind_call(v)
        return "#<#{name}>" if ivars.empty?

        parts = ivars.first(PREVIEW_ITEMS).map { |n| "#{n}=#{preview(IVAR_GET.bind_call(v, n), depth + 1)}" }
        parts << "…" if ivars.size > PREVIEW_ITEMS
        "#<#{name} #{parts.join(', ')}>"
      end
    rescue StandardError
      "#<#{class_name(v)}>"
    end

    def clip(text)
      text.length <= PREVIEW_CHARS ? text : "#{text[0, PREVIEW_CHARS]}…"
    end

    # Number of children, or nil when the value has none to show.
    def expandable(v)
      return nil unless scalar(v).nil?

      case v
      when Array then ARRAY_SIZE.bind_call(v)
      when Hash then HASH_SIZE.bind_call(v)
      when Struct then STRUCT_MEMBERS.bind_call(v).size
      when Range then 2
      when Module, Proc, Method, UnboundMethod then nil
      when Exception then 1 + IVARS.bind_call(v).size
      else
        return set_size(v) if set?(v)

        n = IVARS.bind_call(v).size
        n.positive? ? n : nil
      end
    rescue StandardError
      nil
    end

    def children(v)
      case v
      when Array then [ARRAY_FIRST.bind_call(v, MAX_CHILDREN).each_with_index.map { |x, i| ["[#{i}]", x] }, ARRAY_SIZE.bind_call(v)]
      when Hash then [HASH_FIRST.bind_call(v, MAX_CHILDREN).map { |k, x| [clip(preview(k, 1)), x] }, HASH_SIZE.bind_call(v)]
      when Struct
        names = STRUCT_MEMBERS.bind_call(v)
        values = STRUCT_VALUES.bind_call(v)
        [names.first(MAX_CHILDREN).each_with_index.map { |n, i| [n.to_s, values[i]] }, names.size]
      when Range then [[["begin", v.begin], ["end", v.end]], 2]
      when Exception
        out = [["message", EXCEPTION_MESSAGE.bind_call(v)]] + IVARS.bind_call(v).map { |n| [n.to_s, IVAR_GET.bind_call(v, n)] }
        [out, out.size]
      else
        return [set_items(v, MAX_CHILDREN).each_with_index.map { |x, i| ["[#{i}]", x] }, set_size(v)] if set?(v)

        names = IVARS.bind_call(v)
        [names.first(MAX_CHILDREN).map { |n| [n.to_s, IVAR_GET.bind_call(v, n)] }, names.size]
      end
    end
  end

  # ------------------------------------------------------------ evaluator

  # Evaluates a watch expression against a paused frame without running program code.
  class Evaluator
    PLAIN = [NilClass, TrueClass, FalseClass, Integer, Float, String, Symbol, Rational, Complex].freeze
    # Methods of core values that only read them.
    READERS = {
      Array => %i[size length count first last empty? include? index min max sum sort reverse uniq compact flatten take drop join any? all? none? to_a],
      Hash => %i[size length count empty? keys values key? has_key? include? member? value? has_value? fetch dig to_a any? min_by max_by],
      String => %i[size length empty? upcase downcase capitalize reverse strip chars bytes include? start_with? end_with? to_i to_f to_s to_sym ord split index count center ljust rjust * %],
      Symbol => %i[size length to_s to_sym],
      Integer => %i[abs to_s to_i to_f even? odd? zero? positive? negative? pred succ chr digits bit_length between? clamp floor ceil round divmod fdiv pow gcd lcm],
      Float => %i[abs to_s to_i to_f round floor ceil truncate nan? infinite? finite? zero? positive? negative? between? clamp divmod],
      Range => %i[first last min max size count to_a include? cover? sum begin end],
      NilClass => %i[to_a to_s to_i nil?],
    }.freeze
    OPERATORS = %i[+ - * / % ** == != < <= > >= <=> & | ^ << >> =~ ! -@ +@ ~ [] === eql? equal? nil? is_a? kind_of? instance_of? class].freeze
    MAX_ITEMS = 1_000_000

    def initialize(entry)
      @binding = entry[:binding]
      @self = entry[:self]
    end

    def run(source)
      require "prism"
      result = Prism.parse(source.strip, scopes: [@binding ? @binding.local_variables : []])
      raise EvalError, "syntax error: #{result.errors.first.message}" unless result.errors.empty?

      body = result.value.statements&.body || []
      raise EvalError, "write one expression" unless body.size == 1

      eval_node(body.first)
    rescue EvalError
      raise
    rescue SystemStackError
      raise EvalError, "expression is too deeply nested"
    rescue StandardError => e
      raise EvalError, "#{e.class}: #{e.message}"
    end

    def plain?(v, budget = [10_000])
      budget[0] -= 1
      return false if budget[0].negative?

      c = CLASS_OF.bind_call(v)
      return true if PLAIN.include?(c)
      return plain?(v.begin, budget) && plain?(v.end, budget) if c == Range
      return ARRAY_FIRST.bind_call(v, 10_001).all? { |x| plain?(x, budget) } if c == Array
      return HASH_FIRST.bind_call(v, 10_001).all? { |k, x| plain?(k, budget) && plain?(x, budget) } if c == Hash

      false
    end

    def truthy(v)
      !(v.nil? || v == false)
    end

    def eval_node(node)
      case node
      when Prism::IntegerNode, Prism::FloatNode, Prism::RationalNode, Prism::ImaginaryNode then node.value
      when Prism::StringNode then node.unescaped
      when Prism::SymbolNode then node.unescaped.to_sym
      when Prism::NilNode then nil
      when Prism::TrueNode then true
      when Prism::FalseNode then false
      when Prism::SelfNode then @self
      when Prism::ParenthesesNode
        stmts = node.body.is_a?(Prism::StatementsNode) ? node.body.body : [node.body]
        raise EvalError, "write one expression" unless stmts.size == 1

        eval_node(stmts.first)
      when Prism::LocalVariableReadNode
        raise EvalError, "undefined local variable '#{node.name}'" unless @binding&.local_variable_defined?(node.name)

        @binding.local_variable_get(node.name)
      when Prism::InstanceVariableReadNode
        IVAR_DEFINED.bind_call(@self, node.name) ? IVAR_GET.bind_call(@self, node.name) : nil
      when Prism::ArrayNode then node.elements.map { |e| eval_node(e) }
      when Prism::HashNode, Prism::KeywordHashNode
        node.elements.to_h do |a|
          raise EvalError, "this hash form is not supported in watches" unless a.is_a?(Prism::AssocNode)

          k = eval_node(a.key)
          raise EvalError, "hash keys must be plain values" unless plain?(k)

          [k, eval_node(a.value)]
        end
      when Prism::RangeNode
        a = node.left && eval_node(node.left)
        b = node.right && eval_node(node.right)
        raise EvalError, "range ends must be plain values" unless plain?(a) && plain?(b)

        Range.new(a, b, node.exclude_end?)
      when Prism::AndNode
        l = eval_node(node.left)
        truthy(l) ? eval_node(node.right) : l
      when Prism::OrNode
        l = eval_node(node.left)
        truthy(l) ? l : eval_node(node.right)
      when Prism::IfNode
        raise EvalError, "only a ? b : c is supported in watches" unless node.subsequent.is_a?(Prism::ElseNode) && node.statements

        if truthy(eval_node(node.predicate))
          eval_node(node.statements.body.first)
        else
          eval_node(node.subsequent.statements.body.first)
        end
      when Prism::InterpolatedStringNode
        node.parts.map do |p|
          next p.unescaped if p.is_a?(Prism::StringNode)

          v = eval_node(p.statements.body.first)
          raise EvalError, "only plain values can be interpolated in watches" unless plain?(v)

          v.to_s
        end.join
      when Prism::CallNode then call(node)
      else
        raise EvalError, "#{node.class.name.split('::').last.delete_suffix('Node')} expressions are not supported in watches"
      end
    end

    def call(node)
      raise EvalError, "blocks are not supported in watches" if node.block

      if node.receiver.nil?
        raise EvalError, "undefined local variable or method '#{node.name}'" if node.arguments.nil? && !@binding&.local_variable_defined?(node.name)

        raise EvalError, "methods are not called in watches, because they would run program code"
      end
      recv = eval_node(node.receiver)
      args = (node.arguments&.arguments || []).map { |a| eval_node(a) }
      name = node.name
      # A field of one of the program's objects: read it, without calling the reader.
      if !plain?(recv) && args.empty? && !OPERATORS.include?(name) && !Values.core?(recv, Array, Hash)
        ivar = :"@#{name}"
        return IVAR_GET.bind_call(recv, ivar) if IVAR_DEFINED.bind_call(recv, ivar)
        return Values.children(recv)[0].find { |n, _| n == name.to_s }&.last if recv.is_a?(Struct) && STRUCT_MEMBERS.bind_call(recv).include?(name)

        raise EvalError, "'#{name}' is a method of #{Values.class_name(recv)}; watches do not run program code"
      end
      case name
      when :nil? then return recv.nil?
      when :class then return CLASS_OF.bind_call(recv)
      when :is_a?, :kind_of?, :instance_of?
        raise EvalError, "#{name} needs a class" unless args.size == 1 && args[0].is_a?(Module)

        return Kernel.instance_method(name).bind_call(recv, args[0])
      when :equal? then return recv.equal?(args[0])
      when :! then return !truthy(recv)
      end
      ([recv] + args).each do |v|
        raise EvalError, "#{name} on #{Values.class_name(v)} objects is not evaluated, because it would run program code" unless plain?(v)
      end
      owner = CLASS_OF.bind_call(recv)
      allowed = OPERATORS.include?(name) || (READERS[owner] || []).include?(name) || (owner == TrueClass || owner == FalseClass) && name == :to_s
      raise EvalError, "#{name} is not supported in watches" unless allowed

      guard(recv, name, args)
      owner.instance_method(name).bind_call(recv, *args)
    end

    def guard(recv, name, args)
      n = args[0]
      big = name == :** && recv.is_a?(Integer) && n.is_a?(Integer) && n.positive? && recv.abs > 1 && n * [recv.bit_length, 1].max > 100_000
      big ||= name == :<< && recv.is_a?(Integer) && n.is_a?(Integer) && n > 100_000
      big ||= name == :* && (recv.is_a?(String) || recv.is_a?(Array)) && n.is_a?(Integer) && recv.size * n > MAX_ITEMS
      big ||= recv.is_a?(Range) && %i[to_a sum].include?(name) && (recv.size.nil? || recv.size > MAX_ITEMS)
      raise EvalError, "the result would be too large" if big
    end
  end

  # ------------------------------------------------------------ input

  # The program's stdin. Says when a read is about to block, so the worker can
  # show that the program is waiting for input (and not count the wait as running time).
  class WatchedStdin
    def initialize(io, report)
      @io = io
      @report = report
    end

    def watch
      return yield if @io.closed? || @io.ready?

      @report.call(true)
      begin
        yield
      ensure
        @report.call(false)
      end
    end

    %i[gets readline readlines read getc readchar readpartial each_line each_char getbyte readbyte].each do |name|
      define_method(name) { |*args, **kw, &blk| watch { @io.public_send(name, *args, **kw, &blk) } }
    end

    def eof? = watch { @io.eof? }
    def fileno = @io.fileno
    def to_io = @io
    def respond_to_missing?(name, priv = false) = @io.respond_to?(name, priv)
    def method_missing(name, ...) = @io.public_send(name, ...)
  end

  # ------------------------------------------------------------ adapter

  class Adapter
    def initialize(out)
      @out = out
      @out_lock = Mutex.new
      @lock = Monitor.new
      @root = Dir.pwd
      @files = {}
      @paths = {}
      @breakpoints = {} # project path -> {line => true}
      @executable = {}
      @paused = false
      @commands = Queue.new
      @mode = nil # nil | :pause | :in | :over | :out
      @owner = nil # the frame a step over (or out of) stays in (or leaves)
      @stack = [] # every Ruby frame, outermost first; nil for frames outside the project
      @stop_frames = [] # project frames at the current stop, innermost first: [frame, line]
      @stop_reason = nil
      @refs = {}
      @next_ref = 1
      @pumps = []
      @last_raise = nil
      @main = TOPLEVEL_BINDING.receiver
    end

    # -- protocol

    def send_message(msg)
      line = JSON.generate(msg)
      @out_lock.synchronize do
        @out.write("#{line}\n")
        @out.flush
      end
    rescue IOError, Errno::EPIPE
      exit!(0)
    end

    def event(name, **body) = send_message({ type: "event", event: name, **body })

    def respond(seq, success = true, message = nil, **body)
      msg = { type: "response", requestSeq: seq, success: success, **body }
      msg[:message] = message unless message.nil?
      send_message(msg)
    end

    def read_commands(stream)
      stream.each_line do |line|
        line = line.strip
        next if line.empty?

        begin
          req = JSON.parse(line)
          raise ArgumentError, "expected an object" unless req.is_a?(Hash)
        rescue JSON::ParserError, ArgumentError => e
          event("error", message: "invalid request: #{e.message}")
          next
        end
        queued = @lock.synchronize do
          @commands << req if @paused
          @paused
        end
        safe_handle(req, paused: false) unless queued
      end
      # The worker closed the channel: the session is over.
      exit!(0)
    end

    def safe_handle(req, paused:)
      handle(req, paused)
    rescue StandardError => e
      respond(req["seq"], false, "#{e.class}: #{e.message}")
      false
    end

    # Handles one command. Returns true when the program should resume.
    def handle(req, paused)
      seq = req["seq"]
      case req["cmd"]
      when "setBreakpoints"
        file = req["file"].to_s
        respond(seq, file: file, breakpoints: set_breakpoints(file, req["lines"] || []))
      when "pause"
        @lock.synchronize { @mode = :pause } unless paused
        respond(seq)
      when "continue", "stepOver", "stepIn", "stepOut"
        unless paused
          req["cmd"] == "continue" ? respond(seq) : respond(seq, false, "The program is not paused.")
          return false
        end
        if @stop_reason != "exception"
          top = @stop_frames.first
          @mode = { "continue" => nil, "stepOver" => :over, "stepIn" => :in, "stepOut" => :out }[req["cmd"]]
          # Over: stay in the frame's own code (its blocks included). Out: leave the frame itself.
          @owner = top && (req["cmd"] == "stepOut" ? top[0] : owner_of(top[0]))
        end
        respond(seq)
        return true
      when "variables"
        if paused
          respond(seq, ref: req["ref"], variables: variables(req["ref"]))
        else
          respond(seq, false, "The program is running.")
        end
      when "evaluate"
        expr = req["expression"].to_s
        frame = paused && @stop_frames[req["frame"].to_i]
        if !paused
          respond(seq, expression: expr, error: "The program is running.")
        elsif frame.nil?
          respond(seq, expression: expr, error: "That frame is no longer available.")
        else
          begin
            respond(seq, expression: expr, result: format(Evaluator.new(frame[0]).run(expr)))
          rescue EvalError => e
            respond(seq, expression: expr, error: e.message)
          end
        end
      when "terminate"
        respond(seq)
        exit!(0)
      else
        respond(seq, false, "unknown command: #{req['cmd']}")
      end
      false
    end

    # -- files and breakpoints

    def project(path)
      return nil if path.nil?

      @paths.fetch(path) do
        rel = File.expand_path(path, @root).delete_prefix("#{@root}/")
        @paths[path] = @files.key?(rel) ? rel : nil
      end
    end

    def executable_lines(file)
      @executable[file] ||= begin
        lines = {}
        todo = [RubyVM::InstructionSequence.compile_file(File.join(@root, file))]
        until todo.empty?
          iseq = todo.pop
          iseq.trace_points.each { |line, ev| lines[line] = true if ev == :line }
          iseq.each_child { |c| todo << c }
        end
        lines.keys.sort
      rescue SyntaxError, StandardError, ScriptError
        []
      end
    end

    # Where each breakpoint stops: its own line when it has code, else the next line that has.
    def place(file, lines)
      code = @files.key?(file) ? executable_lines(file) : []
      report = []
      stops = {}
      lines.each do |n|
        at = code.include?(n) ? n : code.find { |l| l > n }
        if at
          stops[at] = true
          report << { line: n, verified: true, actual: at }
        else
          report << { line: n, verified: false }
        end
      end
      [report, stops]
    end

    def set_breakpoints(file, lines)
      report, stops = place(file, lines.map(&:to_i).uniq.sort)
      @lock.synchronize { stops.empty? ? @breakpoints.delete(file) : @breakpoints[file] = stops }
      report
    end

    # -- tracking frames

    def on(tp)
      case tp.event
      when :call, :b_call, :class then push(tp)
      when :return, :b_return, :end then @stack.pop
      when :line then line(tp)
      when :raise
        @last_raise = [tp.raised_exception, project_frames] if project(tp.path)
      end
    rescue StandardError => e
      event("error", message: "tracer: #{e.class}: #{e.message}")
    end

    def push(tp)
      file = project(tp.path)
      return @stack << nil unless file

      entry = { name: frame_name(tp), file: file, binding: tp.binding, line: tp.lineno, self: tp.self, method: tp.event == :call, method_id: tp.method_id }
      if tp.event == :b_call
        # The frame the block was written in: stepping over a line that runs a block stops in the block.
        entry[:block] = true
        entry[:home] = @stack.reverse_each.find { |e| e && !e[:block] && e[:method_id] == tp.method_id && e[:self].equal?(tp.self) }
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
        top = { name: main ? "<main>" : "<top (required)>", file: file, required: !main, self: tp.self, method_id: tp.method_id }
        @stack << top
      end
      top[:binding] = tp.binding
      top[:line] = tp.lineno

      if (stops = @breakpoints[file]) && stops[tp.lineno]
        stop("breakpoint")
      elsif @mode == :pause
        stop("pause")
      elsif @mode == :in
        stop("step")
      elsif @mode == :over || @mode == :out
        alive = @owner && @stack.any? { |e| e.equal?(@owner) }
        stop("step") if !alive || (@mode == :over && owner_of(top).equal?(@owner))
      end
    end

    # The frame whose code a frame runs: a block's is the method (or file) it was written in.
    def owner_of(entry)
      entry = entry[:home] while entry[:block] && entry[:home]
      entry
    end

    # The project's frames as they are now, innermost first: each with the line it is on.
    def project_frames
      @stack.compact.select { |e| e[:binding] }.reverse.map { |e| [e, e[:line]] }
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

    # -- stopping

    def stop(reason, description: nil, frames: nil)
      frames ||= project_frames
      @lock.synchronize do
        @paused = true
        @mode = nil
        @owner = nil
        @stop_frames = frames
        @stop_reason = reason
        @refs.clear
        @next_ref = 1
      end
      body = {
        reason: reason,
        thread: THREAD_NAME,
        frames: frames.each_with_index.map { |(e, line), i| { id: i, name: e[:name], file: e[:file], line: line, localsRef: register([:frame, e]) } },
      }
      body[:description] = description if description
      event("stopped", **body)
      loop do
        break if safe_handle(@commands.pop, paused: true)
      end
      leftover = @lock.synchronize do
        @paused = false
        @stop_frames = []
        @refs.clear
        Array.new(@commands.size) { @commands.pop }
      end
      event("continued")
      leftover.each { |req| safe_handle(req, paused: false) }
    end

    # -- variables

    def register(target)
      ref = @next_ref
      @next_ref += 1
      @refs[ref] = target
      ref
    end

    def format(v)
      count = Values.expandable(v)
      d = { value: Values.clip(Values.preview(v)), type: Values.class_name(v), ref: count ? register([:value, v]) : 0 }
      d[:length] = count if v.is_a?(Array) || v.is_a?(Hash) || Values.set?(v)
      d
    end

    def describe(name, v) = format(v).merge(name: name)

    def locals(entry)
      # A block's frame shows its own variables, then those around it that it can use.
      b = entry[:binding]
      out = b.local_variables.first(MAX_CHILDREN).map { |n| describe(n.to_s, b.local_variable_get(n)) }
      out.unshift(describe("self", entry[:self])) if entry[:method] && !entry[:self].equal?(@main)
      out
    end

    def variables(ref)
      target = @refs[ref]
      raise "variable reference expired; the program has resumed" unless target

      kind, obj = target
      return locals(obj) if kind == :frame

      items, total = Values.children(obj)
      out = items.map { |name, v| describe(name, v) }
      out << { name: "…", value: "#{total - items.size} more", type: "", ref: 0 } if total > items.size
      out
    end

    # -- launch and run

    def pump(reader, stream)
      loop do
        text = reader.readpartial(65_536)
        event("output", stream: stream, text: text.force_encoding(Encoding::UTF_8).scrub)
      end
    rescue EOFError, IOError
      reader.close unless reader.closed?
    end

    def redirect_stdio(stdin_path)
      STDIN.reopen(stdin_path && File.exist?(stdin_path) ? stdin_path : File::NULL)
      [[STDOUT, "stdout"], [STDERR, "stderr"]].each do |io, stream|
        r, w = IO.pipe
        io.reopen(w)
        w.close
        io.sync = true
        @pumps << Thread.new { pump(r, stream) }
      end
      $stdin = WatchedStdin.new(STDIN, ->(waiting) { event("input", waiting: waiting) })
      $stdout = STDOUT
      $stderr = STDERR
    end

    def launch(req)
      @root = File.expand_path(req["root"] || Dir.pwd)
      @files = (req["files"] || []).to_h { |f| [f.to_s, true] }
      Dir.chdir(@root)
      redirect_stdio(req["stdinPath"])
      (req["breakpoints"] || {}).each do |file, lines|
        next if lines.nil? || lines.empty?

        report, stops = place(file, lines.map(&:to_i).uniq.sort)
        @breakpoints[file] = stops unless stops.empty?
        event("breakpoints", file: file, breakpoints: report)
      end
      req["entry"].to_s
    end

    def run(entry)
      ARGV.clear
      $0 = entry
      tp = TracePoint.new(:line, :call, :return, :b_call, :b_return, :class, :end, :raise) { |t| on(t) }
      code = 0
      tp.enable(target_thread: Thread.current)
      begin
        load entry
      rescue SystemExit => e
        code = e.status
      rescue Exception => e # rubocop:disable Lint/RescueException -- the program's own uncaught exception
        tp.disable
        uncaught(e)
        code = 1
      ensure
        tp.disable
      end
      code
    end

    def uncaught(error)
      frames = @last_raise && @last_raise[0].equal?(error) ? @last_raise[1] : []
      stop("exception", description: "#{Values.class_name(error)}: #{EXCEPTION_MESSAGE.bind_call(error)}", frames: frames) unless frames.empty?
      # The backtrace as a normal run prints it: the program's own lines, not the adapter's.
      here = File.expand_path(__FILE__)
      kept = (error.backtrace || []).reject { |l| l.start_with?(here) }
      error.set_backtrace(kept.map { |l| l.delete_prefix("#{@root}/") })
      $stderr.write(error.full_message(highlight: false, order: :top))
    end

    def finish(code)
      [$stdout, $stderr].each do |io|
        io.flush
      rescue StandardError
        nil
      end
      STDOUT.close
      STDERR.close
      @pumps.each { |t| t.join(2) }
      event("exited", exitCode: code)
      exit!(0)
    end
  end

  def self.main
    proto = STDOUT.dup
    proto.sync = true
    commands = STDIN.dup
    adapter = Adapter.new(proto)
    launch = nil
    commands.each_line do |line|
      begin
        req = JSON.parse(line)
      rescue JSON::ParserError => e
        adapter.event("error", message: "invalid request: #{e.message}")
        next
      end
      if req.is_a?(Hash) && req["cmd"] == "launch"
        launch = req
        break
      end
      adapter.respond(req.is_a?(Hash) ? req["seq"] : nil, false, "program not launched")
    end
    exit!(0) unless launch
    begin
      entry = adapter.launch(launch)
    rescue StandardError => e
      adapter.respond(launch["seq"], false, "#{e.class}: #{e.message}")
      exit!(1)
    end
    Thread.new { adapter.read_commands(commands) }
    adapter.respond(launch["seq"])
    adapter.event("continued")
    code = 0
    # The program's own at_exit handlers run before the session ends (they run last-registered first).
    at_exit { adapter.finish(code) }
    code = adapter.run(entry)
    exit(code)
  end
end

CwDebug.main
