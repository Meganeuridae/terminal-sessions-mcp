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
const SHELL_OPENER = /^(?:(?:sudo|doas|env|command|exec|time)\s+(?:(?:-\S+|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)*)*(?:ssh|mosh|sudo\s+-[is]\b|su\b|docker\s+(?:exec|run)\b|podman\s+(?:exec|run)\b|kubectl\s+exec\b|nix-shell\b|nix\s+develop\b|poetry\s+shell\b|pipenv\s+shell\b|limactl\s+shell\b|lima\s+shell\b|vagrant\s+ssh\b|(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|mksh|fish)(?:\s|$))/;
export const looksLikeShellOpener = (line: string | undefined): boolean => line !== undefined && SHELL_OPENER.test(line.trim());

/**
 * Does the line, at a command position, turn on errexit in the shell it runs in (`set -e`,
 * `set -euo pipefail`, `set -o errexit`)? In a session shell that stays on: the next
 * failing command ends the whole shell, and the Run in it ends `lost`. A hint only.
 */
const ERREXIT = /(?:^|[;&|\n]\s*|\b(?:then|do|else)\s+)set\s+(?:-[A-Za-df-z]*e[A-Za-z]*\b|-o\s+errexit\b)/;
export const looksLikeErrexit = (line: string | undefined): boolean => line !== undefined && ERREXIT.test(line);

/**
 * Is the line a one-shot `ssh [options] host command` without `-t`/`-tt`? Such a remote
 * command has no terminal: a cancel here ends ssh and nothing reaches the command, and a
 * dropped connection does not hang it up, so it runs on until it writes to the closed
 * connection. Returns the host for the hint, or undefined. A hint only.
 */
const SSH_OPT_WITH_ARG = new Set(['-b', '-B', '-c', '-D', '-e', '-E', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-P', '-Q', '-R', '-S', '-W', '-w']);
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
    if (/^-t+$/.test(w) || /^-[A-Za-z]*t/.test(w)) tty = true;
    if (SSH_OPT_WITH_ARG.has(w)) i++;
  }
  if (tty || i >= words.length) return undefined;
  const host = words[i]!;
  return i + 1 < words.length ? host : undefined; // a host alone opens a shell: that is the other hint
}
