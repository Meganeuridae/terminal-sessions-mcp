/**
 * The bash integration (§7): a `--rcfile` wrapper, bash 3.2 compatible.
 *
 * Written as a template literal: `$\{` below is the shell's `${`, `\\` is one backslash.
 */
export const BASH_RC = `__tsm_st0=$?
# --- tsm shell integration (bash) --- generated; do not edit
#
# bash reads this file as its --rcfile. It emulates a login shell when asked
# (VS Code's technique: /etc/profile, then the first of ~/.bash_profile,
# ~/.bash_login, ~/.profile), otherwise sources ~/.bashrc, then installs the hooks
# that emit the session's marks. Every mark ends in ";k=<key>": the key arrives in
# a private file named for this PID, read and removed here, never in the environment.
# It stays unexported, so children and nested shells cannot inherit it.
#
# The hooks never trip the user's set -e / set -u, chain a DEBUG trap the rc
# installed, join bash-preexec's arrays when it is loaded, and heal themselves when
# something reassigns PROMPT_COMMAND (to an array on bash >= 5.1, to nothing, or unsets
# it: PS1 then puts it back) or replaces the DEBUG trap. An "exec bash" re-integrates
# through an inherited PROMPT_COMMAND that sources this file again; "exec zsh" and
# "exec fish" through the shim directory and vendor snippet beside this file.
#
# PROMPT_COMMAND is '__tsm_precmd; eval "$__tsm_top"'. The second half runs at top
# level, which is where the DEBUG trap must be inspected and reinstalled: inside a
# function bash 3.2 hides the trap, and restores the caller's when the function
# returns.

if [ "$\{1-}" = reinit ] && [ -n "$\{__tsm_key-}" ]; then
  # Already integrated. Typed by the daemon (its hello came after the startup cap): nothing to do.
  if [ "$\{2-}" = typed ]; then return 0; fi
  # An armed exec did not replace this shell (it failed, or only redirected).
  __tsm_exec_disarm
  __tsm_setst "$__tsm_st0"
  __tsm_precmd
  eval "$__tsm_top"
  return 0
fi

__tsm_rc=$\{BASH_SOURCE[0]-}
__tsm_dir=$\{__tsm_rc%/*}
# Reinit may run after an rc enabled allexport and a DEBUG trap which starts
# ordinary children. Disable allexport before any credential assignment, not after.
__tsm_before_key_opts=$-
set +a
unset __tsm_key
__tsm_key=
if [ -r "$__tsm_dir/key-$$" ]; then
  IFS= builtin read -r __tsm_key < "$__tsm_dir/key-$$"
  /bin/rm -f -- "$__tsm_dir/key-$$"
fi
export -n __tsm_key
case $__tsm_before_key_opts in *a*) set -a ;; esac
unset __tsm_before_key_opts
__tsm_login=$\{TSM_LOGIN-}
__tsm_no_user_rc=$\{TSM_NO_USER_RC-}
__tsm_user_rcfile=$\{TSM_USER_RCFILE-}
__tsm_histfile=$\{TSM_HISTFILE-}
__tsm_session_path=$\{TSM_SESSION_PATH-}
__tsm_session_path_set=$\{TSM_SESSION_PATH+1}
# What an armed exec in a zsh or fish of this session exported for the shell it became:
# the user's own values come back (a bash needs only the key).
if [ -n "$\{ZDOTDIR+x}" ] && [ "$ZDOTDIR" = "$__tsm_dir" ]; then
  if [ -n "$\{TSM_USER_ZDOTDIR+x}" ]; then ZDOTDIR=$TSM_USER_ZDOTDIR; else unset ZDOTDIR; fi
fi
case $\{XDG_DATA_DIRS-} in
  "$__tsm_dir":*)
    if [ -n "$\{TSM_XDG_DATA_DIRS-}" ]; then XDG_DATA_DIRS=$TSM_XDG_DATA_DIRS; else unset XDG_DATA_DIRS; fi
    ;;
esac
if [ -n "$\{TSM_XDG_CONFIG_HOME+x}" ] && [ "$\{XDG_CONFIG_HOME-}" = "$__tsm_dir/no-user-config" ]; then
  if [ -n "$TSM_XDG_CONFIG_HOME" ]; then XDG_CONFIG_HOME=$TSM_XDG_CONFIG_HOME; else unset XDG_CONFIG_HOME; fi
fi
unset TSM_LOGIN TSM_NO_USER_RC TSM_USER_RCFILE TSM_HISTFILE TSM_BASH_RC TSM_SESSION_PATH TSM_USER_ZDOTDIR TSM_XDG_DATA_DIRS TSM_XDG_CONFIG_HOME

# The handshake: integration is loading; the daemon waits for the first prompt.
if [ -n "$__tsm_key" ]; then
  builtin printf '\\033]633;P;TsmHello=bash;k=%s\\007' "$__tsm_key"
fi

if [ "$\{1-}" = reinit ]; then
  # Sourced from an inherited PROMPT_COMMAND by a fresh bash: its rc already ran. What that rc
  # appended to the inherited value (its own \`+=\`) is the user's part from here on — the tail
  # folds it in — and the handoff's own element goes. Whatever of it still runs at this prompt
  # is the prompt's own, not a Run: the DEBUG trap stands down until our hook has run once
  # (the house's read of 1d83ffa). A second word, "typed", means the daemon typed this line at
  # the prompt of a bash whose rc replaced PROMPT_COMMAND outright (no hello came): the whole
  # value is then the user's part, and the prompt's hook is left to PROMPT_COMMAND.
  export -n PROMPT_COMMAND
  __tsm_pcs=()
  for __tsm_e in "$\{PROMPT_COMMAND[@]}"; do
    __tsm_e=$\{__tsm_e//' . "$TSM_BASH_RC" reinit'/}
    case $__tsm_e in *[![:space:]\\;]*) __tsm_pcs+=("$__tsm_e") ;; esac
  done
  unset PROMPT_COMMAND
  # Solo when nothing of the inherited value runs after our hook at this prompt: then precmd may
  # clear __tsm_reinit_pending (promptvars off never lets PS1 do it); with an appended part still to
  # run, PS1 clears it after that part, so the DEBUG trap stands down for it (#22 comment 6264958172).
  if [ "$\{#__tsm_pcs[@]}" -gt 0 ]; then PROMPT_COMMAND=("$\{__tsm_pcs[@]}"); __tsm_reinit_solo=; else __tsm_reinit_solo=1; fi
  # The typed reinit (the daemon's line at the prompt of a bash whose rc replaced PROMPT_COMMAND
  # outright) runs nothing of that value after our hook — precmd runs the folded user part itself —
  # so it is solo too; left non-solo, promptvars off kept the flag set for good (the reviewer's read
  # of the r16 commits, #22).
  if [ "$\{2-}" = typed ]; then __tsm_reinit_solo=1; fi
  unset __tsm_pcs __tsm_e
  __tsm_reinit_pending=1
  if [ -z "$__tsm_key" ]; then return 0; fi
elif [ -z "$__tsm_no_user_rc" ]; then
  if [ -n "$__tsm_login" ]; then
    if [ -r /etc/profile ]; then . /etc/profile; fi
    if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
    elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
    elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
    fi
  elif [ -n "$__tsm_user_rcfile" ]; then
    if [ -r "$__tsm_user_rcfile" ]; then . "$__tsm_user_rcfile"; fi
  elif [ -r "$HOME/.bashrc" ]; then
    . "$HOME/.bashrc"
  fi
fi
if [ -z "$__tsm_key" ]; then return 0; fi

__tsm_o=$-
set +eu

# ss-7: login files (macOS path_helper in /etc/profile) and the user's rc reorder PATH. A
# PATH the session was created with comes first again, in its own order; entries the
# startup files added follow it.
if [ -n "$__tsm_session_path_set" ]; then
  __tsm_rest=
  __tsm_left=$PATH:
  while [ -n "$__tsm_left" ]; do
    __tsm_e=$\{__tsm_left%%:*}
    __tsm_left=$\{__tsm_left#*:}
    if [ -n "$__tsm_e" ]; then
      case ":$__tsm_session_path:" in *":$__tsm_e:"*) ;; *) __tsm_rest=$__tsm_rest:$__tsm_e ;; esac
    fi
  done
  PATH=$__tsm_session_path$__tsm_rest
  export PATH
  unset __tsm_rest __tsm_left __tsm_e
fi
unset __tsm_session_path __tsm_session_path_set

__tsm_setst() { return "$\{1-0}"; }
__tsm_osc() { builtin printf '\\033]%s;k=%s\\007' "$1" "$__tsm_key"; }
# VS Code's value escaping, into __tsm_ret: \\ ; and the controls that would end an OSC.
__tsm_escape() {
  __tsm_ret=$\{1//\\\\/\\\\\\\\}
  __tsm_ret=$\{__tsm_ret//;/\\\\x3b}
  __tsm_ret=$\{__tsm_ret//$'\\n'/\\\\x0a}
  __tsm_ret=$\{__tsm_ret//$'\\r'/\\\\x0d}
  __tsm_ret=$\{__tsm_ret//$'\\a'/\\\\x07}
  __tsm_ret=$\{__tsm_ret//$'\\033'/\\\\x1b}
}
# Re-arm the user's errexit/nounset ($1: the saved $-).
__tsm_restore() {
  case $1 in *e*) set -e ;; esac
  case $1 in *u*) set -u ;; esac
}
# The accepted line, into __tsm_ret: from history when this command was saved there
# (the history number advanced), else BASH_COMMAND. "history 1" alone would name the
# previous command under ignorespace, HISTIGNORE or set +o history. A daemon line is
# always BASH_COMMAND: it is exactly what the daemon matches, whatever the history
# numbers say (a bind -x widget on bash 3.2, which has no READLINE_LINE to tell it
# apart from a line, leaves them stale).
__tsm_cmdline() {
  local __h __n
  case $BASH_COMMAND in
    ". '"*tsm-cmd-*"'")
      __tsm_ret=$BASH_COMMAND
      return 0
      ;;
  esac
  __h=$(HISTTIMEFORMAT= builtin history 1)
  __h=$\{__h#"$\{__h%%[! ]*}"}
  __n=$\{__h%%[!0-9]*}
  if [ -n "$__n" ] && [ "$__n" != "$__tsm_hist_n" ]; then
    __tsm_hist_n=$__n
    __h=$\{__h#"$__n"}
    __h=$\{__h#?}
    __tsm_ret=$\{__h# }
  else
    __tsm_ret=$BASH_COMMAND
  fi
}
# D for the command that just ended ($1: its status).
__tsm_close() {
  if [ -n "$__tsm_in_cmd" ]; then
    # A daemon command file ends by capturing its pipeline's statuses into __tsm_ps (the
    # statuses of '.' itself are all the hook could see): they ride on D as p=1,0.
    if [ -n "$\{__tsm_ps+x}" ]; then __tsm_osc "133;D;$1;p=$\{__tsm_ps// /,}"; else __tsm_osc "133;D;$1"; fi
    __tsm_in_cmd=
  fi
  unset __tsm_ps __tsm_st
  if [ -z "$__tsm_hist_init" ]; then
    __tsm_hist_init=1
    __tsm_cmdline
  fi
}
# cwd, prompt start, and the prompt-end mark at the end of PS1 (re-appended when a
# prompt command rebuilt PS1). Expanding PS1 arms pre-execution detection.
__tsm_open() {
  __tsm_escape "$PWD"
  __tsm_osc "633;P;Cwd=$__tsm_ret"
  case $\{PS1-} in *"$__tsm_b"*) ;; *) PS1="$\{PS1-}$__tsm_b" ;; esac
  case $\{PS1-} in *"$__tsm_a"*) ;; *) PS1="$__tsm_a$\{PS1-}" ;; esac
  __tsm_osc '133;A'
  __tsm_opened=1
}
# What the accepted line runs, into __tsm_ret: for a daemon line (" . '<tmp>/tsm-cmd-…'")
# the file's text. $1: the accepted line.
__tsm_text() {
  local __t=$1 __f
  __t=$\{__t#"$\{__t%%[! ]*}"}
  case $__t in
    ". '"*tsm-cmd-*"'")
      __f=$\{__t#". '"}
      __f=$\{__f%"'"}
      __f=$\{__f//"'\\\\''"/"'"}
      __t=
      IFS= read -r -d '' __t 2>/dev/null < "$__f"
      ;;
  esac
  __tsm_ret=$__t
}
# Does the text ($1) exec (replace this shell)?
__tsm_execs() {
  case " $1" in
    *[[:space:]\\;\\&\\|\\(]exec|*[[:space:]\\;\\&\\|\\(]exec[[:space:]]*) return 0 ;;
  esac
  return 1
}
__tsm_preexec() {
  local __line
  __tsm_cmdline
  __line=$__tsm_ret
  __tsm_escape "$__line"
  __tsm_osc "633;E;$__tsm_ret"
  __tsm_osc '133;C'
  __tsm_in_cmd=1
  # A typed line's Run has started: later DEBUG firings in it are the line's own, even one that
  # matches a PROMPT_COMMAND the line itself just set (the house's read, #22 comment 6264958172: a
  # typed \`PROMPT_COMMAND="history -a"; history -a; sleep 3\` read as idle, its heal mistaking the
  # line's own \`history -a\` for the prompt's). The heal stands down until the next precmd (ss-9).
  # A daemon line (sourced through \`.\`) suspends the DEBUG trap, so it has no later firings of its
  # own; leaving the text empty for it keeps the heal working at the prompt that follows it. The
  # text is kept, not a flag: a later firing is the line's own only if the line runs that command
  # (__tsm_line_has) — a flag alone stood the heal down at the next prompt too, where it was the only
  # closer of a line that merely assigned PROMPT_COMMAND (the reviewer's read of the r16 commits).
  case $__line in ". '"*tsm-cmd-*"'") __tsm_line_text= ;; *) __tsm_line_text=$__line ;; esac
  __tsm_opened=
  __tsm_text "$__line"
  # A command that may set a DEBUG trap — one that names trap, or sources a file or evals text that
  # could (the house's read of 1d83ffa: a sourced file's trap lost the next Run): check ours at the
  # next prompt.
  case " $__tsm_ret" in *trap*|*[[:space:]\\;\\&\\|\\(]source[[:space:]]*|*[[:space:]\\;\\&\\|\\(]eval[[:space:]]*|*[[:space:]\\;\\&\\|\\(].[[:space:]]*) __tsm_trap_suspect=1 ;; esac
  if __tsm_execs "$__tsm_ret"; then __tsm_exec_arm; fi
}
__tsm_precmd() {
  local __st=$? __o=$-
  set +eu
  # (An empty line ran no command since the last prompt armed pre-execution detection.)
  __tsm_prompt_active=
  __tsm_line_text=
  __tsm_top=
  if [ -n "$__tsm_exec_armed" ]; then __tsm_exec_disarm; fi
  # Our DEBUG trap did not fire for the last command, or the command may have set a
  # trap: check it at top level, after this function.
  if [ -z "$__tsm_dbg_tick" ] || [ -n "$__tsm_trap_suspect" ]; then
    __tsm_top='if __tsm_retrap "$(trap -p DEBUG)"; then trap __tsm_debug DEBUG; fi'
  fi
  __tsm_dbg_tick=
  __tsm_trap_suspect=
  __tsm_close "$__st"
  # The prompt before this one ran with PROMPT_COMMAND emptied or unset by a command; PS1
  # put the hook back (ss-3). The user's part went with what the command did.
  if [ "$\{__tsm_pc_lost:-0}" != 0 ]; then
    __tsm_pc_lost=0
    __tsm_user_pc=
  fi
  # The user's part runs once per prompt: when the DEBUG trap folded a reassigned
  # PROMPT_COMMAND at this prompt, what the new value put before the hook already ran.
  if [ "$__tsm_heal_at" = "$__tsm_prompt_no" ]; then __tsm_u=$__tsm_user_now; else __tsm_u=$__tsm_user_pc; fi
  __tsm_heal_at=
  if [ -n "$__tsm_u" ]; then
    __tsm_setst "$__st"
    eval "$__tsm_u"
  fi
  # (Already opened when the DEBUG trap healed a reassigned PROMPT_COMMAND this prompt:
  # a second prompt start would end a Run the daemon just wrote.)
  if [ -z "$__tsm_opened" ]; then __tsm_open; fi
  __tsm_opened=
  # Arm pre-execution detection at the end of PROMPT_COMMAND (the B mark in PS1 arms it
  # too, unless promptvars is off). Commands after the hook (the append idiom, or later
  # elements of an array PROMPT_COMMAND on bash >= 5.1) still run after this function:
  # fold them into the user's part for next time, and leave arming to the PS1 expansion
  # that follows them — armed, they would look like a command (ss-9).
  # Clearing __tsm_reinit_pending is PS1's job (the B mark), except with promptvars off, where
  # PS1 expands no command/arith substitution: when the hook stands alone (nothing of the inherited
  # value runs after it — __tsm_reinit_solo), clear it here too, so the DEBUG trap does not stand
  # down for good on the next Run after \`exec bash\` (the house's read, #22 comment 6264958172).
  # With an appended part still to run and promptvars off, neither can clear it: the DEBUG trap then
  # clears it at the first command that is not one of the user's prompt part (see __tsm_debug). The
  # solo mark is consumed here, so later prompts do not carry the clear for the shell's life.
  if __tsm_pc_intact; then __tsm_top="$\{__tsm_top:+$__tsm_top; }$\{__tsm_reinit_solo:+__tsm_reinit_pending=0; }__tsm_prompt_active=1"; __tsm_reinit_solo=; else __tsm_fold_pc; fi
  __tsm_restore "$__o"
  # Leave $? as the command left it (PS1 may show it); never under errexit, where
  # returning a failure would end the shell.
  case $__o in *e*) ;; *) __tsm_setst "$__st" ;; esac
}
__tsm_debug() {
  local __st=$? __o=$-
  set +eu
  __tsm_dbg_tick=1
  # At the prompt a handoff landed on, the rest of the inherited PROMPT_COMMAND still runs after
  # the reinit: not a Run. PS1's end mark clears this before anyone can type — except with
  # promptvars off, where nothing else can: so the trap stands down while detection is not armed
  # (the rc's own commands after the trap was set, and the hook itself) and for a command of the
  # user's prompt part (the leftover is made of those); the first armed command that is neither is
  # the line someone typed, and clears the flag (the reviewer's read of the r16 commits, #22).
  if [ "$\{__tsm_reinit_pending:-0}" != 0 ]; then
    if [ -z "$__tsm_prompt_active" ] || __tsm_word_in "$BASH_COMMAND" "$__tsm_user_pc"; then
      __tsm_restore "$__o"
      return 0
    fi
    __tsm_reinit_pending=0
  fi
  if [ -n "$__tsm_prev_debug" ]; then
    __tsm_setst "$__st"
    eval "$__tsm_prev_debug"
  fi
  if [ "$BASH_COMMAND" != __tsm_precmd ] && [ -z "$__tsm_exec_armed" ] && ! __tsm_pc_intact; then
    if [ -n "$__tsm_line_text" ] && __tsm_line_has "$BASH_COMMAND"; then
      # A typed line's Run is running and this command is one the line runs itself: the line's own,
      # not the prompt's (so no close here). Still fold the reassignment back behind our hook, so the
      # next prompt's precmd runs and closes the Run — without it the Run read as idle while
      # \`sleep 3\` ran on (the house's read, #22 comment 6264958172). A command the line does not
      # run is the prompt's own at the next prompt, healed as before: for a line that only assigned
      # PROMPT_COMMAND the heal is the only closer (the reviewer's read of the r16 commits).
      __tsm_fold_pc
    else
      # A command of the prompt's own (it stands in PROMPT_COMMAND) is never a Run.
      if __tsm_heal_pc "$__st"; then __tsm_prompt_active=; fi
    fi
  fi
  if [ -n "$__tsm_prompt_active" ] && [ -z "$\{COMP_LINE-}" ] && [ -z "$\{READLINE_LINE+x}" ] && [ "$BASH_COMMAND" != __tsm_precmd ]; then
    __tsm_prompt_active=
    __tsm_preexec
  fi
  __tsm_restore "$__o"
  return 0
}
# PROMPT_COMMAND runs our hook and nothing after it. bash >= 5.1 runs every element of
# an array PROMPT_COMMAND, so "$\{PROMPT_COMMAND}" (element 0) alone says too little.
__tsm_pc_intact() {
  [ "$\{#PROMPT_COMMAND[@]}" -le 1 ] && [ "$\{PROMPT_COMMAND-}" = "$__tsm_pc" ]
}
# Something reassigned PROMPT_COMMAND (a re-sourced rc, an installer, vte.sh's
# PROMPT_COMMAND+=(__vte_osc7)). Keep what it meant as the user's part — every element,
# newline-joined; the prepend and append idioms keep the old part where the hook stood —
# and put the hook back as the only element.
__tsm_fold_pc() {
  local __pc= __e
  for __e in "$\{PROMPT_COMMAND[@]}"; do
    if [ -n "$__e" ]; then __pc=$\{__pc:+$__pc$'\\n'}$__e; fi
  done
  case $__pc in
    *"$__tsm_pc"*) __tsm_user_pc=$\{__pc//"$__tsm_pc"/$__tsm_user_pc} ;;
    *__tsm_precmd*)
      __tsm_user_pc=$\{__pc//__tsm_precmd/$__tsm_user_pc}
      __tsm_user_pc=$\{__tsm_user_pc//'eval "$__tsm_top"'/:}
      ;;
    *) __tsm_user_pc=$__pc ;;
  esac
  unset PROMPT_COMMAND
  PROMPT_COMMAND=$__tsm_pc
}
# From the DEBUG trap ($1: the status the prompt should report). Succeeds when the
# command is one of PROMPT_COMMAND's own (bash is running the new value for this
# prompt): our hook will not run before it, so the Run closes now.
__tsm_heal_pc() {
  local __e __own=
  for __e in "$\{PROMPT_COMMAND[@]}"; do
    # Leading blanks are not part of what bash runs; a compound element (\`if …; then f; fi\`)
    # runs as its simple commands, so a word of the element counts too (the house's read of 1d83ffa).
    __e=$\{__e#"$\{__e%%[![:space:]]*}"}
    case $__e in "$BASH_COMMAND"*) __own=1 ;; esac
    case " $__e " in *[[:space:]\\;\\(\\{\\&\\|]"$BASH_COMMAND"[[:space:]\\;\\)\\}\\&\\|]*) __own=1 ;; esac
  done
  __tsm_user_now=$__tsm_user_pc
  __tsm_heal_at=$__tsm_prompt_no
  __tsm_fold_pc
  if [ -n "$__own" ] && [ -n "$__tsm_in_cmd" ]; then
    __tsm_close "$1"
    __tsm_open
  fi
  [ -n "$__own" ]
}
# Is $1 (a simple command the DEBUG trap sees) a word of $2, bounded by blanks or list/group operators?
__tsm_word_in() {
  case " $2 " in *[[:space:]\\;\\(\\{\\&\\|]"$1"[[:space:]\\;\\)\\}\\&\\|]*) return 0 ;; esac
  return 1
}
# Does the typed line now running (__tsm_line_text) run $1, a simple command the DEBUG trap sees,
# itself? Matched as __tsm_heal_pc matches a PROMPT_COMMAND element: bounded by blanks or list/group
# operators. The quoted value of each PROMPT_COMMAND assignment in the line is dropped first: it names
# the prompt's commands whether or not the line runs them, and a compound value ("if …; then cmd; fi")
# would otherwise match at the next prompt and leave that Run unclosed. The line's first command is
# never a later firing, so it needs a separator before it. Residual: a line that runs a command and
# then ends by assigning the same text to PROMPT_COMMAND reads the next prompt's run of it as its own.
__tsm_line_has() {
  local __t=$__tsm_line_text __h __v __q __dq=\\" __sq=\\'
  while :; do
    case $__t in
      *PROMPT_COMMAND+=[$__dq$__sq]*) __h=$\{__t%%PROMPT_COMMAND+=[$__dq$__sq]*}; __v=$\{__t#"$__h"PROMPT_COMMAND+=} ;;
      *PROMPT_COMMAND=[$__dq$__sq]*) __h=$\{__t%%PROMPT_COMMAND=[$__dq$__sq]*}; __v=$\{__t#"$__h"PROMPT_COMMAND=} ;;
      *) break ;;
    esac
    __q=$\{__v%"$\{__v#?}"}
    __v=$\{__v#?}
    case $__v in *"$__q"*) __v=$\{__v#*"$__q"} ;; *) __v= ;; esac
    __t=$__h$__v
  done
  case "$__t " in *[[:space:]\\;\\(\\{\\&\\|]"$1"[[:space:]\\;\\)\\}\\&\\|]*) return 0 ;; esac
  return 1
}
# At top level ($1: "trap -p DEBUG" there). Succeeds when the DEBUG trap is no longer
# ours: the replacement is kept, chained, and the caller reinstalls ours.
__tsm_retrap() {
  case $\{1-} in *__tsm_debug*) return 1 ;; esac
  __tsm_prev_debug=
  if [ -n "$\{1-}" ]; then eval "__tsm_grab $\{1#trap }"; fi
  return 0
}
__tsm_grab() { __tsm_prev_debug=$\{2-}; }
# An exec replaces this process: tell the daemon (it watches whether the program that
# follows is a shell that re-integrates, ss-4), and export what a fresh shell of ours
# needs to integrate — bash at its first prompt through PROMPT_COMMAND, zsh through the
# shim directory, fish through the vendor snippet (same pid, so the key file matches;
# nested shells fail it). Disarmed at the next prompt if the exec did not happen.
__tsm_exec_arm() {
  __tsm_exec_armed=1
  __tsm_osc '633;P;TsmExec=1'
  __tsm_had_zdotdir=$\{ZDOTDIR+1} __tsm_saved_zdotdir=$\{ZDOTDIR-}
  __tsm_had_xdg=$\{XDG_DATA_DIRS+1} __tsm_saved_xdg=$\{XDG_DATA_DIRS-}
  __tsm_had_cfg=$\{XDG_CONFIG_HOME+1} __tsm_saved_cfg=$\{XDG_CONFIG_HOME-}
  # A textual exec hint is not authority to give every child our key. Only a
  # startup shim with this same PID consumes the private handoff file.
  (umask 077; builtin printf '%s\\n' "$__tsm_key" > "$__tsm_dir/key-$$")
  export TSM_BASH_RC="$__tsm_rc"
  if [ -n "$__tsm_histfile" ]; then export TSM_HISTFILE="$__tsm_histfile"; fi
  if [ -n "$__tsm_no_user_rc" ]; then export TSM_NO_USER_RC=1; fi
  PROMPT_COMMAND=' . "$TSM_BASH_RC" reinit'
  export PROMPT_COMMAND
  if [ -n "$__tsm_had_zdotdir" ]; then export TSM_USER_ZDOTDIR="$__tsm_saved_zdotdir"; fi
  export ZDOTDIR="$__tsm_dir"
  export TSM_XDG_DATA_DIRS="$__tsm_saved_xdg" XDG_DATA_DIRS="$__tsm_dir:$\{__tsm_saved_xdg:-/usr/local/share:/usr/share}"
  if [ -n "$__tsm_no_user_rc" ]; then export TSM_XDG_CONFIG_HOME="$__tsm_saved_cfg" XDG_CONFIG_HOME="$__tsm_dir/no-user-config"; fi
}
__tsm_exec_disarm() {
  /bin/rm -f -- "$__tsm_dir/key-$$"
  __tsm_exec_armed=
  export -n PROMPT_COMMAND
  PROMPT_COMMAND=$__tsm_pc
  if [ -n "$__tsm_had_zdotdir" ]; then ZDOTDIR=$__tsm_saved_zdotdir; else unset ZDOTDIR; fi
  if [ -n "$__tsm_had_xdg" ]; then XDG_DATA_DIRS=$__tsm_saved_xdg; else unset XDG_DATA_DIRS; fi
  if [ -n "$__tsm_no_user_rc" ]; then
    if [ -n "$__tsm_had_cfg" ]; then XDG_CONFIG_HOME=$__tsm_saved_cfg; else unset XDG_CONFIG_HOME; fi
  fi
  unset TSM_BASH_RC TSM_HISTFILE TSM_NO_USER_RC TSM_USER_ZDOTDIR TSM_XDG_DATA_DIRS TSM_XDG_CONFIG_HOME
}
# bash-preexec owns the DEBUG trap and PROMPT_COMMAND; it restores $? for each hook.
__tsm_bp_first() {
  local __st=$? __o=$-
  set +eu
  if [ -n "$\{__tsm_exec_armed-}" ]; then __tsm_exec_disarm; fi
  __tsm_prompt_active=
  __tsm_line_text=  # only the trap path reads it (bash-preexec never installs __tsm_debug); cleared as precmd does
  __tsm_close "$__st"
  __tsm_restore "$__o"
}
# Ahead of bash-preexec's DEBUG handler: it calls preexec functions only for a line it
# finds in history, and daemon lines never go there (a fresh session's history is empty),
# so pre-execution is detected here, armed by the prompt-end mark as without it. Commands
# of PROMPT_COMMAND's own are never a Run.
__tsm_bp_debug() {
  local __o=$- __e
  set +eu
  if [ -n "$__tsm_prompt_active" ] && [ -z "$\{COMP_LINE-}" ] && [ -z "$\{READLINE_LINE+x}" ]; then
    for __e in "$\{PROMPT_COMMAND[@]}"; do
      case $__e in "$BASH_COMMAND"*) __tsm_restore "$__o"; return 0 ;; esac
    done
    __tsm_prompt_active=
    __tsm_preexec
  fi
  __tsm_restore "$__o"
}
__tsm_bp_last() {
  local __o=$-
  set +eu
  __tsm_open
  __tsm_restore "$__o"
}
__tsm_bp_preexec() {
  local __o=$-
  set +eu
  __tsm_preexec
  __tsm_restore "$__o"
}
# G6, ux-3: a history tool the rc loaded (atuin, mcfly, hstr, hishtory) must not open the
# user's global history on Up or C-r: a key bound to one of them ($2 in "bind" notation, in
# keymap $1) goes back to readline's own function ($3), which walks this session's history.
# (bash 3.2 has no bind -x with a line buffer, and these tools bind nothing there.)
__tsm_reclaim_key() {
  local __l
  while IFS= read -r __l; do
    case $__l in
      "\\"$2\\": "*)
        case $__l in *atuin*|*mcfly*|*hstr*|*hishtory*|*'\\C-x\\C-_A'*) bind -m "$1" "\\"$2\\": $3" ;; esac
        ;;
    esac
  done <<< "$(bind -m "$1" -s 2>/dev/null; bind -m "$1" -X 2>/dev/null)"
}
__tsm_own_history_keys() {
  if [ "$\{BASH_VERSINFO[0]-3}" -lt 4 ]; then return 0; fi
  __tsm_reclaim_key emacs '\\C-r' reverse-search-history
  __tsm_reclaim_key emacs '\\e[A' previous-history
  __tsm_reclaim_key emacs '\\eOA' previous-history
  __tsm_reclaim_key vi-insert '\\C-r' reverse-search-history
  __tsm_reclaim_key vi-insert '\\e[A' previous-history
  __tsm_reclaim_key vi-insert '\\eOA' previous-history
  __tsm_reclaim_key vi-command '\\e[A' previous-history
  __tsm_reclaim_key vi-command '\\eOA' previous-history
  __tsm_reclaim_key vi-command 'k' previous-history
  __tsm_reclaim_key vi-command '/' vi-search
}

__tsm_in_cmd=
__tsm_prompt_active=
__tsm_line_text=
__tsm_opened=
__tsm_dbg_tick=
__tsm_hist_n=
__tsm_hist_init=
__tsm_exec_armed=
__tsm_ret=
__tsm_user_pc=
__tsm_prev_debug=
__tsm_top=
__tsm_trap_suspect=
__tsm_u=
__tsm_user_now=
__tsm_heal_at=
__tsm_prompt_no=0
__tsm_pc_lost=0
__tsm_pc='__tsm_precmd; eval "$__tsm_top"'
if [ -n "$\{bash_preexec_imported-}$\{__bp_imported-}" ]; then
  __tsm_bp=1
  precmd_functions=(__tsm_bp_first "$\{precmd_functions[@]}" __tsm_bp_last)
  __tsm_t=$(declare -f __bp_preexec_invoke_exec)
  if [ -n "$__tsm_t" ]; then
    eval "__tsm_bp_invoke_exec $\{__tsm_t#__bp_preexec_invoke_exec }"
    __bp_preexec_invoke_exec() { __tsm_bp_debug; __tsm_bp_invoke_exec "$@"; }
  else
    preexec_functions=("$\{preexec_functions[@]}" __tsm_bp_preexec)
  fi
  unset __tsm_t
  __tsm_pcv=$\{PROMPT_COMMAND-}
else
  __tsm_bp=
  __tsm_fold_pc  # a fresh shell's rc, or what a new shell's rc appended to the handoff (reinit)
  __tsm_pcv=$__tsm_pc
  __tsm_t=$(trap -p DEBUG)
  case $__tsm_t in *__tsm_debug*) __tsm_t= ;; esac
  if [ -n "$__tsm_t" ]; then eval "__tsm_grab $\{__tsm_t#trap }"; fi
  unset __tsm_t
  trap '__tsm_debug' DEBUG
fi
# The prompt-end mark, at the end of PS1. The key is referenced, not written into PS1,
# so an rc that exports PS1 hands children no key. PS1's expansion also heals a
# PROMPT_COMMAND a command emptied or unset (ss-3), where no hook ever runs to put it
# back: while PROMPT_COMMAND is empty, the start of PS1 prints the prompt-start mark (the
# Run that did it ends lost, G5), and its end flags the loss and assigns the hook again —
# all inside invisible \\[ \\] parts, empty otherwise. The end numbers the prompts, and
# arms pre-execution detection.
# (No variable holds a raw mark: bash 3.2's \`set\` prints values raw, and a printed keyed
# mark is a mark. The start of PS1 picks the mark from its own text: element 0 is unset.)
__tsm_sel=([10]='')
__tsm_one=([0]=1 [10]=0)
__tsm_nz=$__tsm_pcv
__tsm_a='\\[$\{__tsm_sel[$\{PROMPT_COMMAND:+1}0]-\\033]133;A;k=$\{__tsm_key}\\007}\\]'
__tsm_b='\\[\\033]133;B;h=$((__tsm_pc_lost|=__tsm_one[$\{PROMPT_COMMAND:+1}0]))$\{__tsm_nz#$\{PROMPT_COMMAND:=$__tsm_pcv}};a=$((__tsm_reinit_pending=0,__tsm_prompt_active=1,__tsm_prompt_no+=1));k=$\{__tsm_key}\\007\\]'
PS1="$__tsm_a$\{PS1-}$__tsm_b"
# ss-1: the daemon types these two keys (ctrl-alt-shift-F12, -F11) before every line, so
# nothing left in the editor merges with it, in any keymap: F12 empties the line (and in
# vi-command mode enters insert mode first), F11 empties it.
bind -m emacs '"\\e[24;8~": kill-whole-line' 2>/dev/null
bind -m emacs '"\\e[23;8~": kill-whole-line' 2>/dev/null
bind -m vi-insert '"\\e[24;8~": kill-whole-line' 2>/dev/null
bind -m vi-insert '"\\e[23;8~": kill-whole-line' 2>/dev/null
bind -m vi-command '"\\e[24;8~": vi-insertion-mode' 2>/dev/null
bind -m vi-command '"\\e[23;8~": kill-whole-line' 2>/dev/null
__tsm_own_history_keys
# The session's own history, and none of the daemon's plumbing in it.
if [ -n "$__tsm_histfile" ]; then HISTFILE=$__tsm_histfile; fi
HISTIGNORE="$\{HISTIGNORE:+$HISTIGNORE:} . '*tsm-cmd-*'"
__tsm_restore "$__tsm_o"
unset __tsm_o
# Re-integrated after an exec, inside the inherited PROMPT_COMMAND: run this prompt's
# hook now. It must be the last command here: the DEBUG trap is live, and any command
# after the hook would look like a command typed at the prompt.
if [ "$\{1-}" = reinit ] && [ "$\{2-}" != typed ]; then
  if [ -n "$__tsm_bp" ]; then __tsm_bp_last; else __tsm_dbg_tick=1; __tsm_precmd; eval "$__tsm_top"; fi
fi
`;
