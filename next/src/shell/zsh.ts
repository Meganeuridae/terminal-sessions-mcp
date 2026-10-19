/**
 * The zsh integration (§7): a ZDOTDIR shim, VS Code's technique.
 *
 * Written as template literals: `$\{` below is the shell's `${`, `\\` is one backslash.
 */

/** Shared by every shim file: whether this zsh integrates, and the user's ZDOTDIR. */
export const ZSH_ZSHENV = `# --- tsm shell integration (zsh .zshenv shim) --- generated; do not edit
#
# zsh reads this because ZDOTDIR points at the shim directory. Each shim file
# forwards to the user's own file with the user's ZDOTDIR — keeping the one the
# user's .zshenv chooses (XDG layouts) — and ZDOTDIR stays on the shim only until
# the user's .zshrc (or, in a login shell, .zlogin) has been read. Every mark ends
# in ";k=<key>": the key is read from this PID's private file (never the environment)
# into an unexported variable, and the file is removed. A zsh with another PID finds
# no handoff file and is a plain zsh.
() {
  emulate -L zsh
  typeset -g __tsm_key=
  if [[ -r $ZDOTDIR/key-$$ ]]; then
    IFS= builtin read -r __tsm_key < "$ZDOTDIR/key-$$"
    /bin/rm -f -- "$ZDOTDIR/key-$$"
  fi
  typeset -g +x __tsm_key
  typeset -g __tsm_shim=$ZDOTDIR __tsm_no_user_rc=$\{TSM_NO_USER_RC-} __tsm_histfile=$\{TSM_HISTFILE-}
  if (( $\{+TSM_USER_ZDOTDIR} )); then typeset -g __tsm_user_zdotdir=$TSM_USER_ZDOTDIR; else unset __tsm_user_zdotdir; fi
  if (( $\{+TSM_SESSION_PATH} )); then typeset -g __tsm_session_path=$TSM_SESSION_PATH; fi
  # What an armed exec in a bash or fish of this session exported for the shell it
  # became (ss-4): the user's own values come back.
  if [[ $\{PROMPT_COMMAND-} == ' . "$TSM_BASH_RC" reinit' ]]; then unset PROMPT_COMMAND; fi
  if [[ $\{XDG_DATA_DIRS-} == $__tsm_shim:* ]]; then
    if [[ -n $\{TSM_XDG_DATA_DIRS-} ]]; then export XDG_DATA_DIRS=$TSM_XDG_DATA_DIRS; else unset XDG_DATA_DIRS; fi
  fi
  if (( $\{+TSM_XDG_CONFIG_HOME} )) && [[ $\{XDG_CONFIG_HOME-} == $__tsm_shim/no-user-config ]]; then
    if [[ -n $TSM_XDG_CONFIG_HOME ]]; then export XDG_CONFIG_HOME=$TSM_XDG_CONFIG_HOME; else unset XDG_CONFIG_HOME; fi
  fi
  unset TSM_NO_USER_RC TSM_HISTFILE TSM_USER_ZDOTDIR TSM_SESSION_PATH TSM_BASH_RC TSM_XDG_DATA_DIRS TSM_XDG_CONFIG_HOME
  # The handshake: integration is loading; the daemon waits for the first prompt.
  if [[ -n $__tsm_key ]]; then builtin printf '\\033]633;P;TsmHello=zsh;k=%s\\007' $__tsm_key; fi
}
__tsm_zdot_user() {
  if (( $\{+__tsm_user_zdotdir} )); then ZDOTDIR=$__tsm_user_zdotdir; else unset ZDOTDIR; fi
}
# A ZDOTDIR a startup file set is the user's from then on: it chooses the next file read, and it is
# what the end of startup restores (the house's read of 1d83ffa: it was undone).
__tsm_zdot_keep() {
  if (( $\{+ZDOTDIR} )); then typeset -g __tsm_user_zdotdir=$ZDOTDIR; else unset __tsm_user_zdotdir; fi
}
__tsm_zdot_user
if [[ -z $__tsm_no_user_rc && -f $\{ZDOTDIR:-$HOME}/.zshenv ]]; then builtin source $\{ZDOTDIR:-$HOME}/.zshenv; fi
if [[ -n $__tsm_key ]]; then
  if (( $\{+ZDOTDIR} )); then typeset -g __tsm_user_zdotdir=$ZDOTDIR; else unset __tsm_user_zdotdir; fi
  ZDOTDIR=$__tsm_shim
else
  unset __tsm_key __tsm_shim __tsm_no_user_rc __tsm_histfile __tsm_user_zdotdir __tsm_session_path
  unfunction __tsm_zdot_user
fi
`;

export const ZSH_ZPROFILE = `# --- tsm shell integration (zsh .zprofile shim) --- generated; do not edit
if [[ -z $__tsm_no_user_rc ]]; then
  __tsm_zdot_user
  if [[ -f $\{ZDOTDIR:-$HOME}/.zprofile ]]; then builtin source $\{ZDOTDIR:-$HOME}/.zprofile; fi
  __tsm_zdot_keep
  ZDOTDIR=$__tsm_shim
fi
`;

export const ZSH_ZSHRC = `# --- tsm shell integration (zsh .zshrc shim) --- generated; do not edit
if [[ -z $__tsm_no_user_rc ]]; then
  __tsm_zdot_user
  if [[ -f $\{ZDOTDIR:-$HOME}/.zshrc ]]; then builtin source $\{ZDOTDIR:-$HOME}/.zshrc; fi
  __tsm_zdot_keep
  ZDOTDIR=$__tsm_shim
fi

__tsm_osc() { builtin printf '\\033]%s;k=%s\\007' "$1" "$__tsm_key" }
# VS Code's value escaping, into REPLY: \\ ; and the controls that would end an OSC.
__tsm_escape() {
  emulate -L zsh
  REPLY=$\{1//\\\\/\\\\\\\\}
  REPLY=$\{REPLY//;/\\\\x3b}
  REPLY=$\{REPLY//$'\\n'/\\\\x0a}
  REPLY=$\{REPLY//$'\\r'/\\\\x0d}
  REPLY=$\{REPLY//$'\\a'/\\\\x07}
  REPLY=$\{REPLY//$'\\e'/\\\\x1b}
}
# The first precmd hook: D for the command that just ended. zsh prints PROMPT_SP
# before any precmd hook, so the shim turned the option off and replays the same
# bytes here, after D: no Run's output ends in a stray "%".
__tsm_precmd_first() {
  local __st=$?
  if [[ -o prompt_sp ]]; then __tsm_psp=1; unsetopt prompt_sp; fi
  __tsm_close $__st
}
__tsm_close() {
  emulate -L zsh
  if [[ -n $\{__tsm_exec_armed-} ]]; then __tsm_exec_disarm; fi
  if [[ -n $__tsm_in_cmd ]]; then
    # A daemon command file ends by capturing its pipeline's statuses into __tsm_ps (the
    # statuses of '.' itself are all the hook could see): they ride on D as p=1,0.
    if [[ -n $\{__tsm_ps+x} ]]; then __tsm_osc "133;D;$1;p=$\{__tsm_ps// /,}"; else __tsm_osc "133;D;$1"; fi
    __tsm_in_cmd=
  fi
  unset __tsm_ps __tsm_st
  if (( __tsm_psp )); then __tsm_prompt_sp; fi
}
__tsm_prompt_sp() {
  emulate -L zsh -o extended_glob
  local m=$\{(%):-$\{PROMPT_EOL_MARK-%B%S%#%s%b}}
  local plain=$\{m//$'\\e'\\[[0-9;]#m/}
  integer w=$\{#plain}
  builtin printf '%s%*s\\r%*s\\r' "$m" $(( COLUMNS - w )) '' $w ''
}
# The last precmd hook: cwd and prompt start, after themes rebuild the prompt.
# The line-init hook emits prompt end once the line editor is ready. Keep our
# hooks first and last for the next prompt too.
__tsm_precmd_last() {
  emulate -L zsh
  __tsm_escape "$PWD"
  __tsm_osc "633;P;Cwd=$REPLY"
  __tsm_osc '133;A'
  precmd_functions=(__tsm_precmd_first $\{precmd_functions:#__tsm_precmd_(first|last)} __tsm_precmd_last)
  preexec_functions=($\{preexec_functions:#__tsm_preexec} __tsm_preexec)
  # A plugin loaded after startup may replace the line-init widget our prompt-end mark hangs on;
  # the hook list keeps its widget as the first hook and ours after it (the house's read of 1d83ffa).
  if (( $+functions[add-zle-hook-widget] )); then add-zle-hook-widget line-init __tsm_line_init 2>/dev/null; fi
}
__tsm_preexec() {
  emulate -L zsh
  __tsm_escape "$1"
  __tsm_osc "633;E;$REPLY"
  __tsm_osc '133;C'
  __tsm_in_cmd=1
  if __tsm_execs "$1"; then __tsm_exec_arm; fi
}
# Does the command exec (replace this shell)? For a daemon line (" . '<tmp>/tsm-cmd-…'")
# the command is the file's text.
__tsm_execs() {
  emulate -L zsh -o extended_glob
  local t=$\{1##[[:space:]]#} f
  if [[ $t == ". '"*tsm-cmd-*"'"[[:space:]]# ]]; then
    f=$\{t#". '"}
    f=$\{f%%\\'[[:space:]]#}
    f=$\{f//"'\\\\''"/"'"}
    t=
    if [[ -r $f ]]; then t=$(<$f); fi
  fi
  [[ " $t" == *[[:space:]\\;\\&\\|\\(]exec([[:space:]]*|) ]]
}
# Something removed our precmd hooks (a re-sourced rc that assigns precmd_functions):
# the line editor's start at the next prompt puts them back. The prompt start it
# emits ends the Run in flight as lost — its status is gone — and the next command is
# integrated again. Only at the main prompt: not in vared, select or PS2.
__tsm_line_init() {
  emulate -L zsh
  [[ $CONTEXT == start ]] || return 0
  if ! (( $precmd_functions[(Ie)__tsm_precmd_first] && $precmd_functions[(Ie)__tsm_precmd_last] )); then
    __tsm_in_cmd=
    __tsm_precmd_last
  fi
  # Keep the credential out of PS1, even when the user's prompt is exported.
  __tsm_osc '133;B'
}
# Daemon plumbing (" . '<tmp>/tsm-cmd-…'") never enters history.
__tsm_addhistory() {
  emulate -L zsh -o extended_glob
  if [[ $1 == [[:space:]]#.\\ \\'*tsm-cmd-*\\'[[:space:]]# ]]; then return 1; fi
  return 0
}
# An exec replaces this process: tell the daemon (it watches whether the program that
# follows is a shell that re-integrates, ss-4), and export what a fresh shell of ours
# needs — zsh the shim directory, bash a PROMPT_COMMAND that sources its rc beside it,
# fish the vendor snippet. The key stays in a private file for this PID, never in
# a child's environment. Disarmed at the next prompt if the exec did not happen.
__tsm_exec_arm() {
  typeset -g __tsm_exec_armed=1
  __tsm_osc '633;P;TsmExec=1'
  typeset -g __tsm_had_xdg=$\{+XDG_DATA_DIRS} __tsm_saved_xdg=$\{XDG_DATA_DIRS-} __tsm_had_cfg=$\{+XDG_CONFIG_HOME} __tsm_saved_cfg=$\{XDG_CONFIG_HOME-}
  typeset -g __tsm_had_pc=$\{+PROMPT_COMMAND} __tsm_saved_pc=$\{PROMPT_COMMAND-}
  (umask 077; builtin printf '%s\\n' "$__tsm_key" > "$__tsm_shim/key-$$")
  export ZDOTDIR=$__tsm_shim
  if [[ -n $__tsm_histfile ]]; then export TSM_HISTFILE=$__tsm_histfile; fi
  if (( $\{+__tsm_user_zdotdir} )); then export TSM_USER_ZDOTDIR=$__tsm_user_zdotdir; fi
  if [[ -n $__tsm_no_user_rc ]]; then export TSM_NO_USER_RC=1; fi
  export TSM_BASH_RC=$__tsm_shim/bash-rc.sh PROMPT_COMMAND=' . "$TSM_BASH_RC" reinit'
  export TSM_XDG_DATA_DIRS=$__tsm_saved_xdg XDG_DATA_DIRS=$__tsm_shim:$\{__tsm_saved_xdg:-/usr/local/share:/usr/share}
  if [[ -n $__tsm_no_user_rc ]]; then export TSM_XDG_CONFIG_HOME=$__tsm_saved_cfg XDG_CONFIG_HOME=$__tsm_shim/no-user-config; fi
}
__tsm_exec_disarm() {
  /bin/rm -f -- "$__tsm_shim/key-$$"
  unset __tsm_exec_armed TSM_HISTFILE TSM_USER_ZDOTDIR TSM_NO_USER_RC TSM_BASH_RC TSM_XDG_DATA_DIRS TSM_XDG_CONFIG_HOME
  if (( __tsm_had_pc )); then PROMPT_COMMAND=$__tsm_saved_pc; else unset PROMPT_COMMAND; fi
  if (( __tsm_had_xdg )); then export XDG_DATA_DIRS=$__tsm_saved_xdg; else unset XDG_DATA_DIRS; fi
  if [[ -n $__tsm_no_user_rc ]]; then
    if (( __tsm_had_cfg )); then export XDG_CONFIG_HOME=$__tsm_saved_cfg; else unset XDG_CONFIG_HOME; fi
  fi
  __tsm_zdot_user
}
# ss-1: the daemon types ctrl-alt-shift-F12 and -F11 before every line: whatever the
# editor holds, in whichever keymap, is gone first (in vicmd, insert mode comes back).
__tsm_clear_line() {
  BUFFER=
  CURSOR=0
  if [[ $KEYMAP == vicmd ]]; then zle vi-insert; fi
}
# G6, ux-3: a history tool the rc loaded (atuin, mcfly, hstr, hishtory) must not open the
# user's global history on Up or ^R: those keys go back to zsh's own bindings (the history
# widgets, which walk this session's history; viins ^R is zsh's redisplay).
__tsm_own_history_keys() {
  emulate -L zsh -o extended_glob
  zmodload -i zsh/zleparameter 2>/dev/null
  if (( ! $\{#$\{(M)$\{(k)widgets}:#*(atuin|mcfly|hishtory)*}} )) && [[ -z $\{commands[hstr]-} ]]; then return 0; fi
  local m k w
  for m k w in emacs '^[[A' up-line-or-history emacs '^[OA' up-line-or-history emacs '^R' history-incremental-search-backward \\
      viins '^[[A' up-line-or-history viins '^[OA' up-line-or-history viins '^R' redisplay \\
      vicmd '^[[A' up-line-or-history vicmd '^[OA' up-line-or-history vicmd k up-line-or-history vicmd / vi-history-search-backward; do
    if [[ "$(bindkey -M $m $k 2>/dev/null)" == *(atuin|mcfly|hishtory|hstr)* ]]; then bindkey -M $m $k $w; fi
  done
}
# The end of startup: ZDOTDIR is the user's from here on, so nested zsh read the
# user's own files; the session keeps its own history file, and its own history keys.
# ss-7: login files (macOS path_helper in /etc/zprofile) and the user's rc reorder PATH:
# a PATH the session was created with comes first again, in its own order; entries the
# startup files added follow it.
__tsm_finish() {
  __tsm_zdot_user
  if [[ -n $__tsm_histfile ]]; then HISTFILE=$__tsm_histfile; fi
  if (( $\{+__tsm_session_path} )); then
    local -a __tsm_given
    __tsm_given=($\{(s.:.)__tsm_session_path})
    path=($__tsm_given $\{path:|__tsm_given})
    export PATH
    unset __tsm_session_path
  fi
  __tsm_own_history_keys
  unfunction __tsm_finish
}

() {
  emulate -L zsh
  typeset -g __tsm_in_cmd=
  typeset -gi __tsm_psp=0
  typeset -ga precmd_functions preexec_functions zshaddhistory_functions
  precmd_functions=(__tsm_precmd_first $\{precmd_functions:#__tsm_precmd_(first|last)} __tsm_precmd_last)
  preexec_functions=($\{preexec_functions:#__tsm_preexec} __tsm_preexec)
  zshaddhistory_functions=(__tsm_addhistory $\{zshaddhistory_functions:#__tsm_addhistory})
}
if autoload -Uz add-zle-hook-widget 2>/dev/null; then add-zle-hook-widget line-init __tsm_line_init 2>/dev/null; fi
zle -N __tsm_clear_line
() {
  local m
  for m in emacs viins vicmd; do
    bindkey -M $m '\\e[24;8~' __tsm_clear_line
    bindkey -M $m '\\e[23;8~' __tsm_clear_line
  done
}
if [[ -o prompt_sp && -o prompt_cr ]]; then __tsm_psp=1; fi
unsetopt prompt_sp
if [[ ! -o login ]]; then __tsm_finish; fi
`;

export const ZSH_ZLOGIN = `# --- tsm shell integration (zsh .zlogin shim) --- generated; do not edit
if [[ -z $__tsm_no_user_rc ]]; then
  __tsm_zdot_user
  if [[ -f $\{ZDOTDIR:-$HOME}/.zlogin ]]; then builtin source $\{ZDOTDIR:-$HOME}/.zlogin; fi
fi
__tsm_finish
`;
