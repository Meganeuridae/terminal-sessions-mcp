import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ShellKind } from './types.js';

export interface Nonce {
  counter: number;
  random: string;
}

export const nonceText = (n: Nonce): string => `${n.counter}.${n.random}`;

export interface Launch {
  kind: ShellKind;
  args: string[];
  env: Record<string, string>;
}

export const shellKind = (shell: string): ShellKind => {
  const base = path.basename(shell);
  return base === 'bash' || base === 'zsh' || base === 'fish' ? base : 'none';
};

const sq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
const fishq = (s: string): string => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

export const COMMAND_FILE = 'tsm-cmd-';

const BASH_RC = `if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
fi
HISTFILE=@HISTFILE@
HISTIGNORE="$\{HISTIGNORE:+$HISTIGNORE:} . '*/${COMMAND_FILE}*'"
__tsm_c=@COUNTER@
__tsm_r=@RANDOM@
__tsm_next() {
  __tsm_c=$((__tsm_c + 1))
  if [ -n "$\{SRANDOM-}" ]; then
    __tsm_r=$((SRANDOM % 90000 + 10000))$((SRANDOM % 90000 + 10000))$((SRANDOM % 90000 + 10000))$((SRANDOM % 90000 + 10000))
  else
    __tsm_r=$((RANDOM + 10000))$((RANDOM + 10000))$((RANDOM + 10000))$((RANDOM + 10000))
  fi
}
__tsm_esc() {
  __tsm_ret=$\{1//\\\\/\\\\\\\\}
  __tsm_ret=$\{__tsm_ret//;/\\\\x3b}
  __tsm_ret=$\{__tsm_ret//$'\\n'/\\\\x0a}
  __tsm_ret=$\{__tsm_ret//$'\\r'/\\\\x0d}
  __tsm_ret=$\{__tsm_ret//$'\\t'/\\\\x09}
  __tsm_ret=$\{__tsm_ret//$'\\a'/\\\\x07}
  __tsm_ret=$\{__tsm_ret//$'\\033'/\\\\x1b}
}
__tsm_drain() {
  local __tsm_m
  __tsm_m=$(PATH=/usr/bin:/bin:$PATH stty -g 2>/dev/null) || return 0
  PATH=/usr/bin:/bin:$PATH stty -icanon min 0 time 0 2>/dev/null
  PATH=/usr/bin:/bin:$PATH dd bs=65536 count=1 2>/dev/null
  PATH=/usr/bin:/bin:$PATH stty "$__tsm_m" 2>/dev/null
}
__tsm_end() {
  local __tsm_s=$? __tsm_p="$\{PIPESTATUS[*]}" __tsm_l __tsm_f= __tsm_n __tsm_cwd __tsm_j=$-
  if [ -n "$\{__tsm_ps+x}" ]; then __tsm_p=$__tsm_ps; unset __tsm_ps; fi
  if [ "$\{BASH_VERSINFO[0]}" -ge 4 ]; then
    while builtin read -t 0 2>/dev/null; do
      if IFS= builtin read -r -t 1 __tsm_l; then __tsm_f=$__tsm_f$__tsm_l$'\\n'; else break; fi
    done
  else
    set +m
    __tsm_f=$(__tsm_drain; builtin printf x)
    case $__tsm_j in *m*) set -m ;; esac
    __tsm_f=$\{__tsm_f%x}
  fi
  __tsm_esc "$PWD"
  __tsm_cwd=$__tsm_ret
  __tsm_esc "$__tsm_f"
  __tsm_n=$__tsm_c.$__tsm_r
  __tsm_next
  builtin printf '\\033]133;D;%s;%s;%s;%s;%s;%s;%s\\007' "$__tsm_n" "$__tsm_c.$__tsm_r" "$__tsm_s" "$__tsm_p" "$-" "$__tsm_cwd" "$__tsm_ret"
  case $- in *e*) return 0 ;; esac
  return "$__tsm_s"
}
__tsm_b='\\[\\033]133;B;$\{__tsm_c}.$\{__tsm_r}\\007\\]'
__tsm_hook() {
  local __tsm_pc
  case $\{PS1-} in *'133;B;'*) ;; *) PS1="$\{PS1-}$__tsm_b" ;; esac
  if [ "$\{#PROMPT_COMMAND[@]}" -gt 1 ]; then
    case $\{PROMPT_COMMAND[0]} in __tsm_end$'\\n'*) ;; *) PROMPT_COMMAND[0]=__tsm_end$'\\n'"$\{PROMPT_COMMAND[0]}" ;; esac
    case $\{PROMPT_COMMAND[$\{#PROMPT_COMMAND[@]}-1]} in __tsm_tail) ;; *) PROMPT_COMMAND+=(__tsm_tail) ;; esac
  else
    case $\{PROMPT_COMMAND-} in
      __tsm_end$'\\n'*$'\\n'__tsm_tail) ;;
      *)
        __tsm_pc=$\{PROMPT_COMMAND-}
        __tsm_pc=$\{__tsm_pc//__tsm_end$'\\n'/}
        __tsm_pc=$\{__tsm_pc//$'\\n'__tsm_tail/}
        PROMPT_COMMAND=__tsm_end$'\\n'"$__tsm_pc"$'\\n'__tsm_tail
        ;;
    esac
  fi
}
__tsm_tail() {
  local __tsm_s=$?
  __tsm_hook
  case $- in *e*) return 0 ;; esac
  return "$__tsm_s"
}
__tsm_hook
if [ "$\{BASH_VERSINFO[0]}" -gt 4 ] || { [ "$\{BASH_VERSINFO[0]}" -eq 4 ] && [ "$\{BASH_VERSINFO[1]}" -ge 4 ]; }; then
  PS0="$\{PS0-}"'\\033]133;C;$\{__tsm_c}.$\{__tsm_r};\\007'
fi
`;

const ZSH_FORWARD = (file: string, last: boolean): string => `if (( $\{+__tsm_uzd} )); then ZDOTDIR=$__tsm_uzd; else unset ZDOTDIR; fi
if [[ -r $\{ZDOTDIR:-$HOME}/${file} ]]; then builtin source $\{ZDOTDIR:-$HOME}/${file}; fi
if (( $\{+ZDOTDIR} )); then __tsm_uzd=$ZDOTDIR; else unset __tsm_uzd; fi
${last ? 'builtin source $__tsm_shim/tsm.zsh' : 'ZDOTDIR=$__tsm_shim'}
`;

const ZSH_ENV = `__tsm_shim=$ZDOTDIR
if (( $\{+TSM_USER_ZDOTDIR} )); then __tsm_uzd=$TSM_USER_ZDOTDIR; fi
unset TSM_USER_ZDOTDIR
${ZSH_FORWARD('.zshenv', false)}`;

const ZSH_HOOKS = `if (( $\{+__tsm_uzd} )); then ZDOTDIR=$__tsm_uzd; else unset ZDOTDIR; fi
unset __tsm_uzd
HISTFILE=@HISTFILE@
unsetopt PROMPT_SP PROMPT_CR
typeset -g __tsm_c=@COUNTER@ __tsm_r=@RANDOM@ __tsm_ret __tsm_bs=
__tsm_next() {
  __tsm_c=$((__tsm_c + 1))
  __tsm_r=$((RANDOM + 10000))$((RANDOM + 10000))$((RANDOM + 10000))$((RANDOM + 10000))
}
__tsm_esc() {
  __tsm_ret=$\{1//\\\\/\\\\\\\\}
  __tsm_ret=$\{__tsm_ret//;/\\\\x3b}
  __tsm_ret=$\{__tsm_ret//$'\\n'/\\\\x0a}
  __tsm_ret=$\{__tsm_ret//$'\\r'/\\\\x0d}
  __tsm_ret=$\{__tsm_ret//$'\\t'/\\\\x09}
  __tsm_ret=$\{__tsm_ret//$'\\a'/\\\\x07}
  __tsm_ret=$\{__tsm_ret//$'\\e'/\\\\x1b}
}
__tsm_end() {
  local __tsm_s=$? __tsm_p="$\{(j: :)pipestatus}" __tsm_l __tsm_f= __tsm_n __tsm_cwd
  if (( $\{+__tsm_ps} )); then __tsm_p=$__tsm_ps; unset __tsm_ps; fi
  while builtin read -t 0 -r __tsm_l; do __tsm_f=$__tsm_f$__tsm_l$'\\n'; done
  __tsm_esc "$PWD"
  __tsm_cwd=$__tsm_ret
  __tsm_esc "$__tsm_f"
  __tsm_n=$__tsm_c.$__tsm_r
  __tsm_next
  builtin printf '\\033]133;D;%s;%s;%s;%s;%s;%s;%s\\007' "$__tsm_n" "$__tsm_c.$__tsm_r" "$__tsm_s" "$__tsm_p" "$-" "$__tsm_cwd" "$__tsm_ret"
  return $__tsm_s
}
__tsm_start() {
  __tsm_esc "$1"
  builtin printf '\\033]133;C;%s.%s;%s\\007' "$__tsm_c" "$__tsm_r" "$__tsm_ret"
}
__tsm_tail() {
  if [[ -n $__tsm_bs ]]; then PS1=$\{PS1%"$__tsm_bs"}; fi
  __tsm_bs="%{"$'\\e]133;B;'"$__tsm_c.$__tsm_r"$'\\a'"%}"
  PS1=$PS1$__tsm_bs
}
__tsm_nohist() {
  [[ $1 != ' . '*'/${COMMAND_FILE}'* ]]
}
__tsm_hook() {
  precmd_functions=(__tsm_end $\{precmd_functions:#__tsm_(end|tail)} __tsm_tail)
  preexec_functions=($\{preexec_functions:#__tsm_start} __tsm_start)
}
__tsm_hook
zshaddhistory_functions=($\{zshaddhistory_functions:#__tsm_nohist} __tsm_nohist)
unset __tsm_shim
`;

const FISH_INIT = `set -g fish_history ''
set -g __tsm_c @COUNTER@
set -g __tsm_r @RANDOM@
function __tsm_next
    set -g __tsm_c (math $__tsm_c + 1)
    set -g __tsm_r (random 10000 99999)(random 10000 99999)(random 10000 99999)(random 10000 99999)
end
function __tsm_esc
    set -l v (string replace -a -- '\\\\' '\\\\\\\\' $argv[1] | string collect)
    set v (string replace -a -- ';' '\\\\x3b' $v | string collect)
    set v (string replace -a -- \\n '\\\\x0a' $v | string collect)
    set v (string replace -a -- \\r '\\\\x0d' $v | string collect)
    set v (string replace -a -- \\t '\\\\x09' $v | string collect)
    set v (string replace -a -- \\a '\\\\x07' $v | string collect)
    set v (string replace -a -- \\e '\\\\x1b' $v | string collect)
    printf '%s' $v
end
function __tsm_collect
    string collect < $argv[1]
    return $argv[2]
end
function __tsm_setst
    return $argv[1]
end
function __tsm_start --on-event fish_preexec
    set -l t (__tsm_esc $argv[1])
    printf '\\e]133;C;%s.%s;%s\\a' $__tsm_c $__tsm_r "$t"
end
function __tsm_drain
    set -l m (PATH=/usr/bin:/bin:$PATH stty -g 2>/dev/null); or return 0
    PATH=/usr/bin:/bin:$PATH stty -icanon min 0 time 0 2>/dev/null
    PATH=/usr/bin:/bin:$PATH dd bs=65536 count=1 2>/dev/null
    PATH=/usr/bin:/bin:$PATH stty $m 2>/dev/null
end
function __tsm_d
    set -l f (begin; __tsm_drain; printf x; end | string collect -N)
    set -l n $__tsm_c.$__tsm_r
    __tsm_next
    set -l p $argv
    set -e p[1]
    set -l pj (string join ' ' -- $p)
    set -l cwd (__tsm_esc $PWD)
    set -l fl (__tsm_esc "$f")
    set fl (string replace -r -- 'x$' '' "$fl")
    printf '\\e]133;D;%s;%s;%s;%s;;%s;%s\\a' $n $__tsm_c.$__tsm_r $argv[1] "$pj" "$cwd" "$fl"
end
function __tsm_post --on-event fish_postexec
    set -l x $pipestatus $status
    if set -q __tsm_fps
        set x $__tsm_fps
        set -e __tsm_fps
    end
    set -l p
    if test (count $x) -gt 2
        set p $x[1..-2]
    end
    __tsm_d $x[-1] $p
end
function __tsm_wrap
    if not string match -q '*__tsm_prompt_end*' -- (functions fish_prompt | string collect)
        functions -e __tsm_user_prompt
        functions -c fish_prompt __tsm_user_prompt
        function fish_prompt
            __tsm_user_prompt
            __tsm_prompt_end
        end
    end
end
function __tsm_prompt_end
    printf '\\e]133;B;%s.%s\\a' $__tsm_c $__tsm_r
end
function __tsm_end --on-event fish_prompt
    if not set -q __tsm_up
        set -g __tsm_up 1
        __tsm_d 0
    end
    __tsm_wrap
end
__tsm_wrap
`;

const fill = (text: string, o: { nonce: Nonce; dir: string }, quote: (s: string) => string): string =>
  text.replaceAll('@COUNTER@', String(o.nonce.counter)).replaceAll('@RANDOM@', o.nonce.random).replaceAll('@HISTFILE@', quote(path.join(o.dir, 'history')));

/** Writes the integration's files for `shell` into `dir` and returns how to start it: the user's own startup files run first, the hooks last. */
export function prepare(shell: string, dir: string, nonce: Nonce, env: Record<string, string>): Launch {
  const kind = shellKind(shell);
  const o = { nonce, dir };
  if (kind === 'bash') {
    const rc = path.join(dir, 'rc.bash');
    fs.writeFileSync(rc, fill(BASH_RC, o, sq), { mode: 0o600 });
    return { kind, args: ['--rcfile', rc, '-i'], env: {} };
  }
  if (kind === 'zsh') {
    const shim = path.join(dir, 'zsh');
    fs.mkdirSync(shim, { mode: 0o700 });
    fs.writeFileSync(path.join(shim, '.zshenv'), ZSH_ENV, { mode: 0o600 });
    fs.writeFileSync(path.join(shim, '.zprofile'), ZSH_FORWARD('.zprofile', false), { mode: 0o600 });
    fs.writeFileSync(path.join(shim, '.zshrc'), ZSH_FORWARD('.zshrc', false), { mode: 0o600 });
    fs.writeFileSync(path.join(shim, '.zlogin'), ZSH_FORWARD('.zlogin', true), { mode: 0o600 });
    fs.writeFileSync(path.join(shim, 'tsm.zsh'), fill(ZSH_HOOKS, o, sq), { mode: 0o600 });
    const add: Record<string, string> = { ZDOTDIR: shim };
    if (env.ZDOTDIR !== undefined) add.TSM_USER_ZDOTDIR = env.ZDOTDIR;
    return { kind, args: ['-l', '-i'], env: add };
  }
  if (kind === 'fish') {
    const init = path.join(dir, 'init.fish');
    fs.writeFileSync(init, fill(FISH_INIT, o, fishq), { mode: 0o600 });
    return { kind, args: ['-l', '-i', '-C', `source ${fishq(init)}`], env: {} };
  }
  return { kind, args: [], env: {} };
}

/** The file `run` has the shell source, and the line to type that sources it. The command's status stays its own. */
export function commandFile(kind: ShellKind, dir: string, id: number, text: string): { file: string; body: string; line: string } {
  const file = path.join(dir, `${COMMAND_FILE}${id}`);
  if (kind === 'bash') {
    const start = `case $\{PS0-} in *'133;C;'*) ;; *) builtin printf '\\033]133;C;%s.%s;\\007' "$__tsm_c" "$__tsm_r" ;; esac`;
    const body = `${start}\nbuiltin history -s -- ${sq(text)}\n${text}\n__tsm_st=$? __tsm_ps="$\{PIPESTATUS[*]}"; __tsm_hook 2>/dev/null; return $__tsm_st\n`;
    return { file, body, line: ` . ${sq(file)}\r` };
  }
  if (kind === 'zsh') {
    const body = `builtin print -s -- ${sq(text)}\n${text}\n__tsm_st=$? __tsm_ps="$\{(j: :)pipestatus}"; __tsm_hook 2>/dev/null; return $__tsm_st\n`;
    return { file, body, line: ` . ${sq(file)}\r` };
  }
  if (kind === 'fish') {
    const body = `${text}\nset -g __tsm_fps $pipestatus $status; __tsm_setst $__tsm_fps[-1]\n`;
    return { file, body, line: ` eval (__tsm_collect ${fishq(file)} $status)\r` };
  }
  return { file, body: text, line: `${text}\r` };
}
