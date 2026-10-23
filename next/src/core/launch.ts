/**
 * The shell text the daemon's children start through: one copy of each line, used by the
 * integration launcher (shell/integration.ts), process Runs and shells started without an
 * integration (backends/node-pty.ts), so the three never drift apart; it is core text, with no
 * dependency, so both layers may import it (§13) (the house's read of 2c35df8, #22,
 * where a shell started without a launcher kept the descriptors the others close).
 */

/**
 * The line that closes every descriptor above the ones in `keep` (a `case` pattern such as
 * `0|1|2`) before a child runs. node-pty opens each session's terminal master without
 * close-on-exec, and Node passes a child every descriptor that isn't, so a child held the master of
 * every session open when it started: it could have written into those terminals, another
 * principal's included, and it kept a shell alive after the daemon died, since the terminal never
 * hung up (the house's review of #11, issue #18, and the read of d5873f0). The descriptors are
 * listed through /dev/fd (Linux links it to /proc/self/fd); the glob is expanded, and its directory
 * closed, before the loop runs. Only bash can name an arbitrary descriptor in `exec N>&-` (dash
 * reads `exec 12>&-` as a command named 12), so the loop runs only under bash, a /bin/sh that is bash
 * included (macOS's: bash sets BASH_VERSION when run as sh), and the same text is a no-op under one
 * that isn't, such as dash.
 */
export function closeFdsLine(keep: string): string {
  return `if [ -n "\${BASH_VERSION-}" ] && [ -d /dev/fd ]; then for __tsm_fd in /dev/fd/*; do case "\${__tsm_fd##*/}" in ${keep}) ;; *) eval "exec \${__tsm_fd##*/}>&-" 2>/dev/null || :;; esac; done; unset __tsm_fd; fi`;
}

/**
 * The line that raises a session process's oom_score_adj on Linux (no /proc elsewhere): the
 * kernel then takes it before the daemon, whose death would lose every session. The preference
 * is machine-wide, not relative to the daemon alone — a raised build is taken before other
 * users' processes too — so the amount is the daemon's `--session-oom-score-adj` (default 200),
 * and 0 writes nothing.
 */
export function oomLine(oomScoreAdj: number): string[] {
  const n = Math.max(0, Math.min(1000, Math.floor(oomScoreAdj)));
  return n > 0 ? [`if [ -w /proc/self/oom_score_adj ]; then echo ${n} > /proc/self/oom_score_adj 2>/dev/null || :; fi`] : [];
}

/**
 * What every process Run starts through: `bash --noprofile --norc -p -c PROCESS_LAUNCH termd-process <argv…>`.
 * It closes every descriptor above stderr (closeFdsLine), raises the oom preference on Linux
 * (oomLine), then runs the command. Only the daemon's constant text is on this command line: a Run
 * given a line gets its text on descriptor 3, which `/bin/sh`, exec'd by the launcher, reads whole,
 * closes, and runs with `eval` (see Session.admit; argv is then `/bin/sh`): the line is in no argv and
 * in no file a crash and a fast restart could remove, and the command's own children never see the
 * descriptor. Bash's privileged mode skips BASH_ENV and imported shell functions before cleanup; the
 * Run's line still executes in /bin/sh, with the environment it was given plus what bash exports on
 * its way (`PWD`, `SHLVL`) and without `_` (the house measured it).
 */
export function processLaunch(readsLine: boolean, oomScoreAdj = 0): string {
  const readLine = [
    '__tsm_line=; while IFS= read -r __tsm_l; do __tsm_line="$__tsm_line$__tsm_l',
    '"; done <&3; __tsm_line="$__tsm_line$__tsm_l"',
    'exec 3<&-',
    'eval "unset __tsm_l __tsm_line; $__tsm_line"',
  ].join('\n');
  return [
    closeFdsLine(readsLine ? '0|1|2|3' : '0|1|2'),
    ...oomLine(oomScoreAdj),
    ...(readsLine
      ? // Read the descriptor itself: Linux cannot reopen Node's socket as /dev/fd/3.
        // Only this constant reader is in argv; its eval removes both temporary variables.
        [`exec /bin/sh -c '${readLine.replaceAll("'", "'\\''")}' termd-process`]
      : ['exec "$@"']),
  ].join('\n');
}

/**
 * What a shell without an integration launcher starts through, where bash is present: the
 * inherited descriptors closed and the oom preference raised, as the integration's launcher does,
 * then `exec` of the shell and its arguments (it keeps the pid).
 */
export function shellLaunch(oomScoreAdj: number): string {
  return [closeFdsLine('0|1|2'), ...oomLine(oomScoreAdj), 'exec "$@"'].join('\n');
}

/** The argv that runs `text` under bash with no startup files and in privileged mode, named `name`, with `args` as its positional parameters. */
export function viaBash(bash: string, text: string, name: string, args: readonly string[]): [string, string[]] {
  return [bash, ['--noprofile', '--norc', '-p', '-c', text, name, ...args]];
}
