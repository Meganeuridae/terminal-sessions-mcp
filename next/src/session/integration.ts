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

const BASH_STARTUP = `if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
fi
HISTFILE=@HISTFILE@
HISTIGNORE="$\{HISTIGNORE:+$HISTIGNORE:} . '*/${COMMAND_FILE}*'"
`;

const BASH_HOOKS = `__tsm_c=@COUNTER@
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
  @DRAIN_CALL@
}
__tsm_end() {
  local __tsm_s=$? __tsm_p="$\{PIPESTATUS[*]}" __tsm_f __tsm_n __tsm_cwd __tsm_j=$- __tsm_t
  if [ -n "$\{__tsm_ps+x}" ]; then __tsm_p=$__tsm_ps; unset __tsm_ps; fi
  set +m
  __tsm_f=$(__tsm_drain)
  __tsm_t=$(builtin trap -p INT)
  case $__tsm_j in *m*) set -m ;; esac
  __tsm_esc "$PWD"
  __tsm_cwd=$__tsm_ret
  __tsm_n=$__tsm_c.$__tsm_r
  builtin trap '' INT
  __tsm_next
  builtin printf '\\033]133;D;%s;%s;%s;%s;%s;%s\\007' "$__tsm_n" "$__tsm_c.$__tsm_r" "$__tsm_s" "$__tsm_p" "$-" "$__tsm_cwd"
  builtin eval "$\{__tsm_t:-builtin trap - INT}"
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

const ZSH_STARTUP = `if (( $\{+__tsm_uzd} )); then ZDOTDIR=$__tsm_uzd; else unset ZDOTDIR; fi
unset __tsm_uzd
HISTFILE=@HISTFILE@
`;

const ZSH_HOOKS = `unsetopt PROMPT_SP PROMPT_CR
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
__tsm_drain() {
  @DRAIN_CALL@
}
__tsm_end() {
  local __tsm_s=$? __tsm_p="$\{(j: :)pipestatus}" __tsm_f __tsm_n __tsm_cwd
  if (( $\{+__tsm_ps} )); then __tsm_p=$__tsm_ps; unset __tsm_ps; fi
  __tsm_f=$(__tsm_drain)
  __tsm_esc "$PWD"
  __tsm_cwd=$__tsm_ret
  __tsm_n=$__tsm_c.$__tsm_r
  setopt localoptions localtraps
  trap '' INT
  __tsm_next
  builtin printf '\\033]133;D;%s;%s;%s;%s;%s;%s\\007' "$__tsm_n" "$__tsm_c.$__tsm_r" "$__tsm_s" "$__tsm_p" "$-" "$__tsm_cwd"
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
`;

const FISH_HOOKS = `set -g fish_history ''
set -g __tsm_c @COUNTER@
set -g __tsm_r @RANDOM@
function __tsm_next
    set -g __tsm_c (math $__tsm_c + 1)
    set -g __tsm_r (random 10000 99999)(random 10000 99999)(random 10000 99999)(random 10000 99999)
end
function __tsm_esc
    # The x keeps a trailing newline from string collect, which trims them.
    set -l v (string replace -a -- '\\\\' '\\\\\\\\' "$argv[1]x" | string collect)
    set v (string replace -a -- ';' '\\\\x3b' $v | string collect)
    set v (string replace -a -- \\n '\\\\x0a' $v | string collect)
    set v (string replace -a -- \\r '\\\\x0d' $v | string collect)
    set v (string replace -a -- \\t '\\\\x09' $v | string collect)
    set v (string replace -a -- \\a '\\\\x07' $v | string collect)
    set v (string replace -a -- \\e '\\\\x1b' $v | string collect)
    printf '%s' (string replace -r -- 'x$' '' $v | string collect)
end
function __tsm_collect
    if test (string split -f1 . -- $FISH_VERSION) -ge 4
        builtin history append -- (string collect < $argv[3])
    end
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
    @DRAIN_CALL@
end
function __tsm_d
    begin; __tsm_drain; end | string collect -N >/dev/null
    set -l n $__tsm_c.$__tsm_r
    function __tsm_noint --on-signal SIGINT
    end
    __tsm_next
    set -l p $argv
    set -e p[1]
    set -l pj (string join ' ' -- $p)
    set -l cwd (__tsm_esc $PWD)
    printf '\\e]133;D;%s;%s;%s;%s;;%s\\a' $n $__tsm_c.$__tsm_r $argv[1] "$pj" "$cwd"
    functions -e __tsm_noint
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
  text
    .replaceAll('@DRAIN_CALL@', `/bin/sh @DRAIN@ @DRAINED@.${quote === fishq ? '$__tsm_c' : '"$__tsm_c"'} 2>/dev/null`)
    .replaceAll('@COUNTER@', String(o.nonce.counter))
    .replaceAll('@RANDOM@', o.nonce.random)
    .replaceAll('@HISTFILE@', quote(path.join(o.dir, 'history')))
    .replaceAll('@DRAIN@', quote(path.join(o.dir, 'drain.sh')))
    .replaceAll('@DRAINED@', quote(path.join(o.dir, DRAINED)));

/** The drain writes what it read to this file in the session's directory, `.` and the counter of the nonce its end mark closes. */
export const DRAINED = 'drained';

/**
 * The typeahead drain every shell's prompt hook runs, as one sh script: it writes the text typed ahead
 * that nothing read into the file it's given, and leaves it unread by anything else. The session reads
 * the file when it parses the end mark, so text of any size costs the hook no escaping. INT is ignored, and its stty and dd inherit
 * that, so a C-c can't leave the terminal out of canonical mode. It reads nothing unless it could save
 * the terminal's modes and change them. The first read waits for nothing; once it found text, each
 * later read waits up to 0.1 s for more, until one finds none or 1 MiB is read, so text that the
 * terminal's input queue (4 KiB on Linux) couldn't hold at once, still on its way, is drained too.
 * The later reads give dd `conv=notrunc`: uutils dd (Ubuntu 26.04's coreutils) empties a regular file
 * it was given as standard output, even one opened to append, when it copies nothing.
 */
const DRAIN = `trap '' INT
PATH=/usr/bin:/bin:$PATH
f=$1
m=$(stty -g 2>/dev/null) || exit 0
stty -icanon min 0 time 0 2>/dev/null || { stty "$m" 2>/dev/null; exit 0; }
dd bs=65536 count=1 2>/dev/null > "$f"
if [ -s "$f" ]; then
  stty min 0 time 1 2>/dev/null
  while :; do
    n=$(wc -c < "$f")
    dd bs=65536 count=1 conv=notrunc 2>/dev/null >> "$f"
    [ $(($(wc -c < "$f"))) -gt $((n)) ] && [ $((n)) -lt 1048576 ] || break
  done
fi
stty "$m" 2>/dev/null
if [ ! -s "$f" ]; then rm -f "$f"; fi
`;

/** Writes the integration's files for `shell` into `dir` and returns how to start it: the user's own startup files run first, the hooks last. */
export function prepare(shell: string, dir: string, nonce: Nonce, env: Record<string, string>): Launch {
  const kind = shellKind(shell);
  const o = { nonce, dir };
  if (kind !== 'none') fs.writeFileSync(path.join(dir, 'drain.sh'), DRAIN, { mode: 0o600 });
  if (kind === 'bash') {
    const rc = path.join(dir, 'rc.bash');
    fs.writeFileSync(rc, fill(BASH_STARTUP + BASH_HOOKS, o, sq), { mode: 0o600 });
    return { kind, args: ['--rcfile', rc, '-i'], env: {} };
  }
  if (kind === 'zsh') {
    const shim = path.join(dir, 'zsh');
    fs.mkdirSync(shim, { mode: 0o700 });
    fs.writeFileSync(path.join(shim, '.zshenv'), ZSH_ENV, { mode: 0o600 });
    fs.writeFileSync(path.join(shim, '.zprofile'), ZSH_FORWARD('.zprofile', false), { mode: 0o600 });
    fs.writeFileSync(path.join(shim, '.zshrc'), ZSH_FORWARD('.zshrc', false), { mode: 0o600 });
    fs.writeFileSync(path.join(shim, '.zlogin'), ZSH_FORWARD('.zlogin', true), { mode: 0o600 });
    fs.writeFileSync(path.join(shim, 'tsm.zsh'), fill(`${ZSH_STARTUP}${ZSH_HOOKS}unset __tsm_shim\n`, o, sq), { mode: 0o600 });
    const add: Record<string, string> = { ZDOTDIR: shim };
    if (env.ZDOTDIR !== undefined) add.TSM_USER_ZDOTDIR = env.ZDOTDIR;
    return { kind, args: ['-l', '-i'], env: add };
  }
  if (kind === 'fish') {
    const init = path.join(dir, 'init.fish');
    fs.writeFileSync(init, fill(FISH_HOOKS, o, fishq), { mode: 0o600 });
    return { kind, args: ['-l', '-i', '-C', `source ${fishq(init)}`], env: {} };
  }
  return { kind, args: [], env: {} };
}

export const TEXT_FILE = 'tsm-text-';

/**
 * The files `run` writes, and the line to type that sources the first. The command's status, and its
 * pipeline's, stay its own. In bash the text has a file of its own, so its syntax ends where that file
 * does; a RETURN trap set around it keeps the pipeline's statuses, which zsh and fish reset through
 * every wrapper. In zsh and fish the text stays inline, followed by a blank line, which ends a trailing
 * backslash's continuation. fish 4 adds the text to its history from a copy in a file of its own; fish 3
 * has no way to add it.
 */
export function commandFile(kind: ShellKind, dir: string, id: number, text: string): { files: Array<{ path: string; body: string }>; line: string } {
  const file = path.join(dir, `${COMMAND_FILE}${id}`);
  if (kind === 'bash') {
    const textFile = path.join(dir, `${TEXT_FILE}${id}`);
    const body = [
      `case $\{PS0-} in *'133;C;'*) ;; *) builtin printf '\\033]133;C;%s.%s;\\007' "$__tsm_c" "$__tsm_r" ;; esac`,
      `builtin history -s -- ${sq(text)}`,
      '__tsm_rt=$(builtin trap -p RETURN)',
      `builtin trap '__tsm_ps="$\{PIPESTATUS[*]}"' RETURN`,
      `builtin . ${sq(textFile)}`,
      '__tsm_st=$?',
      'case $(builtin trap -p RETURN) in *__tsm_ps=*) builtin trap - RETURN; builtin eval "$__tsm_rt" ;; esac',
      '__tsm_hook 2>/dev/null; return $__tsm_st',
      '',
    ].join('\n');
    return { files: [{ path: file, body }, { path: textFile, body: `${text}\n` }], line: ` . ${sq(file)}\r` };
  }
  if (kind === 'zsh') {
    const body = `builtin print -s -- ${sq(text)}\n${text}\n\n__tsm_st=$? __tsm_ps="$\{(j: :)pipestatus}"; __tsm_hook 2>/dev/null; return $__tsm_st\n`;
    return { files: [{ path: file, body }], line: ` . ${sq(file)}\r` };
  }
  if (kind === 'fish') {
    const textFile = path.join(dir, `${TEXT_FILE}${id}`);
    const body = `${text}\n\nset -g __tsm_fps $pipestatus $status; __tsm_setst $__tsm_fps[-1]\n`;
    return { files: [{ path: file, body }, { path: textFile, body: text }], line: ` eval (__tsm_collect ${fishq(file)} $status ${fishq(textFile)})\r` };
  }
  return { files: [], line: `${text}\r` };
}

/**
 * A shell given the integration by typing, as through `ssh`: it shares no files with the session, so
 * everything reaches it on typed lines, and its drain sends what it read back on the terminal.
 */
export type FarKind = Exclude<ShellKind, 'none'>;

/** The probe line: valid in bash, zsh and fish, it prints a K mark with each one's version, empty but for the shell that runs it. */
export const PROBE_LINE = ` printf '\\033]133;K;;%s;%s;%s\\007' "$FISH_VERSION" "$ZSH_VERSION" "$BASH_VERSION"\r`;
/** Typed only when the probe named none of the three, so a POSIX shell runs it: a K mark with `$0`. */
export const PROBE_ZERO_LINE = ` printf '\\033]133;K;;;;;%s\\007' "$0"\r`;

/**
 * The drain for a shell given the integration by typing, run as `sh -c` with the nonce its end mark
 * closes. It reads as the local drain does, and sends each piece it read as an F mark, in hex, to the
 * terminal, before the hook prints its end mark. It turns echo off while it reads: text still arriving
 * would otherwise be echoed into the middle of a mark.
 */
const DRAIN_FAR = `trap '' INT
PATH=/usr/bin:/bin:$PATH
m=$(stty -g 2>/dev/null) || exit 0
stty -icanon -echo min 0 time 0 2>/dev/null || { stty "$m" 2>/dev/null; exit 0; }
n=0
while [ $n -lt 1048576 ]; do
  c=$(dd bs=65536 count=1 2>/dev/null | od -A n -v -t x1 | tr -d ' \\n')
  [ -n "$c" ] || break
  printf '\\033]133;F;%s;%s\\007' "$1" "$c"
  n=$((n + \${#c} / 2))
  stty min 0 time 1 2>/dev/null
done
stty "$m" 2>/dev/null
`;

/**
 * Bytes a typed line carries as they are, inside single quotes: printable ASCII but for the quote, the backslash and `!`, which no
 * line editor acts on there. Every other byte goes as a `\0ooo` escape, which `printf '%b'` decodes.
 */
const SAFE = new Set(Array.from({ length: 0x7f - 0x20 }, (_, i) => i + 0x20).filter((b) => b !== 0x27 && b !== 0x5c && b !== 0x21));
const escaped = (text: string): string => {
  let out = '';
  for (const b of Buffer.from(text, 'utf8')) out += SAFE.has(b) ? String.fromCharCode(b) : `\\0${b.toString(8).padStart(3, '0')}`;
  return out;
};

/**
 * The longest piece of the hooks on one typed line. Until its line editor starts, a shell reads the terminal in canonical mode,
 * where macOS holds at most 1024 bytes (`getconf MAX_CANON` and `MAX_INPUT`), so the hooks go in pieces that each fit. Typed all at once,
 * pieces arrived cut there, so each is typed only once the line before it has run and printed its P mark.
 */
const PIECE = 768;

/** The P mark a typed line prints as its last act, so the next is typed only once the shell has run it: `call` names the call, and `i` the line. */
const ack = (kind: FarKind, call: string, i: number): string => (kind === 'fish' ? `; printf '\\e]133;P;${call}.${i}\\a'` : `; builtin printf '\\033]133;P;${call}.${i}\\007'`);

/** After the hooks, so these replace what the hooks define: the drain's script, a filter that keeps typed lines out of history, and a way for an eval to end with a status. */
const FAR_POST: Record<FarKind, string> = {
  bash: `__tsm_setst() { return "$1"; }
__tsm_pre() {
  case $\{PS0-} in *'133;C;'*) ;; *) builtin printf '\\033]133;C;%s.%s;\\007' "$__tsm_c" "$__tsm_r" ;; esac
  builtin history -s -- "$__tsm_t"
}
HISTIGNORE="$\{HISTIGNORE:+$HISTIGNORE:}"' __tsm_*'
__tsm_dr=@DR@
`,
  zsh: `__tsm_setst() { return $1 }
__tsm_pre() { builtin print -s -- "$__tsm_t" }
__tsm_nohist() { [[ $1 != ' __tsm_'* ]] }
__tsm_dr=@DR@
`,
  fish: `function __tsm_pre
    if test (string split -f1 . -- $FISH_VERSION) -ge 4
        builtin history append -- $__tsm_t
    end
end
set -g __tsm_dr @DR@
`,
};

const FAR_DRAIN_CALL: Record<FarKind, string> = {
  bash: '/bin/sh -c "$__tsm_dr" sh "$__tsm_c.$__tsm_r" 2>/dev/null >/dev/tty',
  zsh: '/bin/sh -c "$__tsm_dr" sh "$__tsm_c.$__tsm_r" 2>/dev/null >/dev/tty',
  fish: '/bin/sh -c "$__tsm_dr" sh $__tsm_c.$__tsm_r 2>/dev/null >/dev/tty',
};

/**
 * The lines that give a shell of `kind` the hooks, its chain starting at `nonce`, each to be typed once the one before has printed
 * its P mark, which carries `call` and the line's index. The first turns saving history to a file off: zsh and fish can save a line as it's entered,
 * and bash a line it ran before a later one runs, so it carries no nonce. The pieces of the escaped program go into a variable,
 * and the last line prints its P mark, then decodes and evals it; the prompt that follows is its acknowledgement. What the shell
 * prints between that mark and its first end mark came from taking the hooks.
 */
export function farHooks(kind: FarKind, nonce: Nonce, call: string): string[] {
  const quote = kind === 'fish' ? fishq : sq;
  const hooks = kind === 'bash' ? BASH_HOOKS : kind === 'zsh' ? ZSH_HOOKS : FISH_HOOKS;
  const program = (hooks + FAR_POST[kind])
    .replaceAll('@DRAIN_CALL@', FAR_DRAIN_CALL[kind])
    .replaceAll('@DR@', quote(DRAIN_FAR))
    .replaceAll('@COUNTER@', String(nonce.counter))
    .replaceAll('@RANDOM@', nonce.random);
  const e = escaped(program);
  const pieces: string[] = [];
  for (let i = 0; i < e.length; ) {
    let j = Math.min(i + PIECE, e.length);
    const k = e.lastIndexOf('\\', j - 1);
    if (j < e.length && k > j - 5) j = k;
    pieces.push(e.slice(i, j));
    i = j;
  }
  const last = pieces.length + 1;
  if (kind === 'fish')
    return [` set -g fish_history ''${ack(kind, call, 0)}\r`, ...pieces.map((p, i) => ` set ${i ? '' : '-g '}__tsm_h ${i ? '"$__tsm_h"' : ''}'${p}'${ack(kind, call, i + 1)}\r`), ` true${ack(kind, call, last)}; eval (printf '%b' "$__tsm_h" | string collect); set -e __tsm_h\r`];
  return [` unset HISTFILE${ack(kind, call, 0)}\r`, ...pieces.map((p, i) => ` __tsm_h=${i ? '$__tsm_h' : ''}'${p}'${ack(kind, call, i + 1)}\r`), ` true${ack(kind, call, last)}; eval "$(printf '%b' "$__tsm_h")"; unset __tsm_h\r`];
}

/**
 * The longest line `run` types into a shell given the integration by typing. zsh's and bash 3's line editors take time that grows
 * with its square: on GitHub's macOS runners, in one run each, an 8 KiB line took them 0.8 to 1.5 s, and 16 KiB 2.5 to 4.8 s.
 */
export const FAR_MAX_TYPED = 8192;

/**
 * The line `run` types into a shell given the integration by typing, at its prompt. The text goes once, escaped, into a variable;
 * `__tsm_pre` adds it to the shell's history (and in bash 3, with no PS0, prints the start mark), and an eval runs it followed by a
 * blank line, which ends a trailing backslash's continuation, and the line that keeps its statuses, so its pipeline's are its own.
 */
export function farCommand(kind: FarKind, text: string): string {
  const e = escaped(text);
  if (kind === 'fish')
    return ` set -g __tsm_t (printf '%b' '${e}' | string collect -N); __tsm_pre; eval (printf '%s\\n\\nset -g __tsm_fps $pipestatus $status' "$__tsm_t" | string collect); __tsm_setst $__tsm_fps[-1]\r`;
  const ps = kind === 'zsh' ? '$\{(j: :)pipestatus}' : '$\{PIPESTATUS[*]}';
  return ` __tsm_t=$(printf '%b' '${e}'); __tsm_pre; builtin eval "$__tsm_t"$'\\n\\n''__tsm_st=$? __tsm_ps="${ps}"'; __tsm_hook 2>/dev/null; __tsm_setst "$__tsm_st"\r`;
}
