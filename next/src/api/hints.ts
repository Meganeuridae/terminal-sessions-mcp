/**
 * Hints about a command line, never evidence (§8.1): does it read like one that opens
 * another shell, turns on errexit, or runs a one-shot ssh command without a terminal?
 * Results use them in their status lines; the compat pack uses the first to keep a
 * command meant for a nested shell from queueing behind it (the house's read of
 * 1cabc6a, #22). A module of its own because the tool table and the compat pack both
 * import it, and the compat pack is part of the tool table.
 */
/**
 * Does the command line read like one that opens another shell (ssh, sudo -i, docker exec, a
 * nested shell, …)? Only ever a hint in a result's text; what is in front is the caller's to say (§8.1).
 */
const SHELL_OPENER = /^(?:(?:sudo|doas|env|command|exec|time)\s+(?:(?:-\S+|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)*)*(?:(?:ssh|mosh|su)(?:\s|$)|sudo\s+-[is]\b|docker\s+(?:exec|run)\b|podman\s+(?:exec|run)\b|kubectl\s+exec\b|nix-shell\b|nix\s+develop\b|poetry\s+shell\b|pipenv\s+shell\b|limactl\s+shell\b|lima\s+shell\b|vagrant\s+ssh(?:\s|$)|(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|mksh|fish)(?:\s|$))/;
// `ssh`, `mosh` and `su` must be whole words: `ssh-keygen`, `ssh-add`, `sshfs` and `ssh-copy-id` open no shell (the house's read of 1cabc6a, #22).
export const looksLikeShellOpener = (line: string | undefined): boolean => line !== undefined && SHELL_OPENER.test(line.trim());

/**
 * The line with the parts a shell would not run as its own words blanked: quoted strings, backtick
 * substitutions, parenthesised groups (a subshell or `$(…)`: `set -e` there ends with it) and heredoc
 * bodies. `echo "build; set -e"`, `bash -c 'set -e; make'`, `(cd sub; set -e; make)` and
 * `grep "x; set -e" f` turn nothing on in the shell that runs them (the house's read of 1cabc6a, #22).
 */
function ownWords(line: string): string {
  let out = '';
  let depth = 0;
  /** Heredoc delimiters whose bodies begin at the next newline. */
  const pending: string[] = [];
  const emit = (s: string) => {
    if (depth === 0) out += s;
  };
  for (let i = 0; i < line.length; ) {
    const c = line[i]!;
    if (c === '\\') {
      emit(' ');
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += c !== "'" && line[j] === '\\' ? 2 : 1;
      emit(' ');
      i = j + 1;
    } else if (c === '(') {
      emit(' ');
      depth++;
      i++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      emit(' ');
      i++;
    } else if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      const m = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(line.slice(i));
      if (m) pending.push(m[1] ?? m[2] ?? m[3]!);
      emit(' ');
      i += m ? m[0].length : 2;
    } else if (c === '\n' && pending.length) {
      // Each body runs to the line that is its delimiter (leading tabs allowed, as with `<<-`).
      let j = i + 1;
      for (const d of pending.splice(0)) {
        for (;;) {
          const nl = line.indexOf('\n', j);
          const l = (nl < 0 ? line.slice(j) : line.slice(j, nl)).replace(/^\t+/, '');
          j = nl < 0 ? line.length : nl + 1;
          if (l === d || nl < 0) break;
        }
      }
      emit('\n');
      i = j;
    } else {
      emit(c);
      i++;
    }
  }
  return out;
}

/**
 * Does the line, at a command position of the shell that runs it, turn on errexit (`set -e`,
 * `set -euo pipefail`, `set -o errexit`)? In a session shell that stays on: the next failing
 * command ends the whole shell, and the Run in it ends `lost`. Inside a loop or an `if` branch
 * it still is the shell's own `set`; inside quotes, a subshell or a heredoc it is not. A hint only.
 */
const ERREXIT = /(?:^|[;&|\n{]\s*|\b(?:then|do|else)\s+)set\s+(?:-[A-Za-df-z]*e[A-Za-z]*\b|-o\s+errexit\b)/;
export const looksLikeErrexit = (line: string | undefined): boolean => line !== undefined && ERREXIT.test(ownWords(line));

/** ssh's single-letter options that take a value (ssh(1)). */
const SSH_OPT_WITH_ARG: ReadonlySet<string> = new Set([...'bBcDeEFIiJLlmOopPQRSWw']);

/**
 * Is the line a one-shot `ssh [options] host command` without `-t`/`-tt`? Such a remote
 * command has no terminal: a cancel here ends ssh and nothing reaches the command, and a
 * dropped connection does not hang it up, so it runs on until it writes to the closed
 * connection. Returns the host for the hint, or undefined. A hint only.
 */
export function oneShotSshWithoutTty(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  const words = line.trim().split(/\s+/);
  let i = 0;
  // Prefixes the shell-opener pattern allows too: sudo/env/command/exec/time and assignments.
  while (i < words.length && (/^(?:sudo|doas|env|command|exec|time)$/.test(words[i]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || (i > 0 && /^-/.test(words[i]!) && /^(?:sudo|doas|env)$/.test(words[i - 1]!)))) i++;
  if (words[i] !== 'ssh') return undefined;
  i++;
  let tty = false;
  for (; i < words.length && words[i]!.startsWith('-'); i++) {
    const w = words[i]!;
    if (w === '--') { i++; break; }
    // Flags bundle (`-At`), and an option's value is attached (`-oBatchMode=yes`, `-lterry`) or the
    // next word (`-o BatchMode=yes`, `-p 22`): the letters after an option that takes a value are
    // that value, never flags — a `t` in `StrictHostKeyChecking` is not `-t` (the house's read of 1cabc6a, #22).
    for (let k = 1; k < w.length; k++) {
      const c = w[k]!;
      if (c === 't') tty = true;
      else if (SSH_OPT_WITH_ARG.has(c)) {
        const value = k + 1 < w.length ? w.slice(k + 1) : words[++i];
        if (c === 'o' && value !== undefined && /^RequestTTY=(?:yes|force)$/i.test(value)) tty = true;
        break;
      }
    }
  }
  if (tty || i >= words.length) return undefined;
  const host = words[i]!;
  return i + 1 < words.length ? host : undefined; // a host alone opens a shell: that is the other hint
}
