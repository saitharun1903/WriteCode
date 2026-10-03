# Code Workspace Bash prelude, for the Bash debugger and tracer.
#
#   bash --noprofile --norc cw_bash_prelude.sh <entry> [args...]
#
# Runs the script with a DEBUG trap, which Bash runs before every command.
# Before a command of one of the project's files, the trap reports the call
# stack and the script's variables to the Python side on fd 9 (CW_EVENTS):
#
#   STEP <reason> <file> <line> <depth>
#   F <function> <file> <line>          one per frame, innermost first
#   declare ...                         `declare -p` of the script's variables
#   END
#
# In trace mode it reports every command, and waits for a line on fd 8 before
# going on, so the output counted for a step is exactly what came before it.
# In debug mode it reports only where
# the program stops (a breakpoint, a step, a pause), then waits for a command
# on fd 8 (CW_COMMANDS): continue, in, over, out. SIGUSR1 asks for a pause,
# SIGUSR2 to reload the breakpoints from CW_BREAKPOINTS (one `file:line` per
# line). A command that is not found is reported as `EXC <file> <line>
# <command>` (and stops the debugger there). The script's own $?, $0 and
# arguments are as in a normal run.

__cw_mode=${CW_MODE:-trace}
__cw_files=" ${CW_FILES} "
__cw_bpfile=${CW_BREAKPOINTS:-}
__cw_pid=$BASHPID
exec 9>"${CW_EVENTS}"
exec 8<"${CW_COMMANDS}"
unset CW_MODE CW_FILES CW_EVENTS CW_COMMANDS CW_BREAKPOINTS

declare -A __cw_bp=()
__cw_step=""
__cw_step_depth=0
__cw_pause=0
__cw_last=""

__cw_load_bp() {
    __cw_bp=()
    local __cw_l
    [[ -n $__cw_bpfile && -r $__cw_bpfile ]] || return 0
    while IFS= read -r __cw_l; do
        [[ -n $__cw_l ]] && __cw_bp[$__cw_l]=1
    done < "$__cw_bpfile"
    return 0
}

# The program's variables: those that did not exist before it started, and not the ones Bash sets in a function.
__cw_known=" $(compgen -v | tr '\n' ' ') FUNCNAME BASH_SOURCE BASH_LINENO BASH_ARGC BASH_ARGV BASH_REMATCH BASH_COMMAND PIPESTATUS _ "
__cw_vars() {
    local __cw_v __cw_out=()
    for __cw_v in $(compgen -v); do
        [[ $__cw_v == __cw_* || $__cw_known == *" $__cw_v "* ]] && continue
        __cw_out+=("$__cw_v")
    done
    ((${#__cw_out[@]})) && declare -p "${__cw_out[@]}" 2>/dev/null
}

__cw_report() {
    # $1: why; frames are read from the caller's caller (the trap's view of the program).
    local __cw_i __cw_n=${#FUNCNAME[@]}
    {
        printf 'STEP %s %s %s %s\n' "$1" "$2" "$3" "$4"
        for ((__cw_i = 2; __cw_i < __cw_n; __cw_i++)); do
            local __cw_f=${BASH_SOURCE[__cw_i]#./} __cw_fn=${FUNCNAME[__cw_i]} __cw_ln=${BASH_LINENO[__cw_i - 1]}
            [[ $__cw_files == *" $__cw_f "* ]] || continue
            [[ $__cw_fn == source ]] && __cw_fn=main
            printf 'F %s %s %s\n' "$__cw_fn" "$__cw_f" "$__cw_ln"
        done
        __cw_vars
        printf 'END\n'
    } >&9
}

# While the script waits for the debugger, its stdin is set aside: the sandbox counts a process blocked
# on a pipe with the program's stdin as its fd 0 as a program waiting for typed input.
__cw_hold() { exec 7<&0 0</dev/null; }
__cw_resume() { exec 0<&7 7<&-; }

__cw_wait() {
    local __cw_cmd
    __cw_hold
    while IFS= read -r __cw_cmd <&8; do
        case $__cw_cmd in
            continue) __cw_step=""; __cw_resume; return 0 ;;
            in | over | out) __cw_step=$__cw_cmd; __cw_step_depth=$1; __cw_resume; return 0 ;;
            bp) __cw_load_bp ;;
        esac
    done
    exit 0
}

# A command substitution runs in a subshell: its steps count when it runs one of the program's functions ($(square 3)).
__cw_counts() {
    [[ $BASHPID == "$__cw_pid" ]] && return 0
    local __cw_i
    for ((__cw_i = 2; __cw_i < ${#FUNCNAME[@]}; __cw_i++)); do
        [[ ${FUNCNAME[__cw_i]} != source && ${FUNCNAME[__cw_i]} != main && $__cw_files == *" ${BASH_SOURCE[__cw_i]#./} "* ]] && return 0
    done
    return 1
}

__cw_trap() {
    # The trap returns 0 (Bash keeps the program's $? across it): a failure of its own would set off the ERR trap.
    [[ $BASH_COMMAND == __cw_* ]] && return 0
    # A file sourced as ./lib.sh is the project's lib.sh.
    local __cw_file=${BASH_SOURCE[1]#./} __cw_line=${BASH_LINENO[0]}
    [[ $__cw_files == *" $__cw_file "* ]] || return 0
    __cw_counts || return 0
    local __cw_depth=${#FUNCNAME[@]} __cw_here="$__cw_file:$__cw_line"
    if [[ $__cw_mode == trace ]]; then
        __cw_report line "$__cw_file" "$__cw_line" "$__cw_depth"
        local __cw_ack
        __cw_hold
        read -r __cw_ack <&8
        __cw_resume
        return 0
    fi
    # One stop per line: a line of several commands is one step.
    local __cw_key="$__cw_here:$__cw_depth"
    local __cw_why=""
    if [[ -n ${__cw_bp[$__cw_here]:-} && $__cw_key != "$__cw_last" ]]; then
        __cw_why=breakpoint
    elif ((__cw_pause)) && [[ $BASHPID == "$__cw_pid" ]]; then
        __cw_why=pause
    elif [[ $__cw_key != "$__cw_last" ]]; then
        case $__cw_step in
            in) __cw_why=step ;;
            over) ((__cw_depth <= __cw_step_depth)) && __cw_why=step ;;
            out) ((__cw_depth < __cw_step_depth)) && __cw_why=step ;;
        esac
    fi
    __cw_last=$__cw_key
    if [[ -n $__cw_why ]]; then
        __cw_pause=0
        __cw_report "$__cw_why" "$__cw_file" "$__cw_line" "$__cw_depth"
        __cw_wait "$__cw_depth"
    fi
    return 0
}

__cw_err() {
    local __cw_status=$?
    ((__cw_status == 127)) || return "$__cw_status"
    [[ $BASHPID == "$__cw_pid" ]] || return "$__cw_status"
    [[ $BASH_COMMAND == __cw_* || ${FUNCNAME[1]:-} == __cw_* ]] && return "$__cw_status"
    local __cw_file=${BASH_SOURCE[1]#./} __cw_line=${BASH_LINENO[0]}
    [[ $__cw_files == *" $__cw_file "* ]] || return "$__cw_status"
    printf 'EXC %s %s %s\n' "$__cw_file" "$__cw_line" "${BASH_COMMAND%% *}" >&9
    if [[ $__cw_mode == debug ]]; then
        __cw_report exception "$__cw_file" "$__cw_line" "${#FUNCNAME[@]}"
        __cw_wait "${#FUNCNAME[@]}"
    fi
    return "$__cw_status"
}

__cw_load_bp
trap '__cw_pause=1' USR1
trap '__cw_load_bp' USR2
__cw_entry=$1
shift
BASH_ARGV0=$__cw_entry
set -T -E
trap '__cw_trap' DEBUG
trap '__cw_err' ERR
source "$__cw_entry" "$@"
