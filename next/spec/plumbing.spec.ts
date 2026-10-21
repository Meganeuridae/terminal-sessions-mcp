/** One grammar for the marks a Run prints and the readers cut around (core/plumbing.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ackMark, commandFile, cutPlumbing, exitMark, goneMark, inlineProbe, inlineTypedLine, keptRanges, markerCommandText, markerProbe, nonceOf, probeEcho, probeMark, shellQuote, sourceLine, sourceLineEcho, startMark } from '../src/core/plumbing.js';
import { inlineLines } from '../src/core/session.js';
import { journalRunText } from '../src/core/segmenter.js';
import { transcript } from '../src/core/transcript.js';
import type { RunOutput } from '../src/core/runindex.js';
import type { RunInfo } from '../src/core/types.js';

/** What the shell prints for a typed line: the split words joined. */
const printed = (typed: string) => typed.replace(/""|''/g, '');

test('the marks the session prints are the marks the grammar parses: start with the pid, exit with a status, probe with pid and token or with neither', () => {
  const last = inlineLines('echo hi', 'n0ff', false).at(-1)!;
  assert.match(last, /STAR''T:n0ff:%s>>>/, 'the typed start marker is split');
  assert.match(last, /__tsm_r=n0ff; printf/, 'the line sets the token the probe prints before the start marker');
  assert.match(inlineLines('echo hi', 'n0ff', true).at(-1)!, /set -g __tsm_r n0ff; printf/);
  assert.match(printed(last).replace('%s', '4242'), startMark('n0ff'));
  assert.equal(startMark('n0ff').exec('<<<START:n0ff:4242>>>')![1], '4242');
  assert.equal(exitMark('n0ff').exec('x\n<<<EXIT:n0ff:-1>>>\n')![1], '-1');
  assert.equal(probeMark('n0ff').exec('<<<PROBE:n0ff>>>')![1], undefined, 'the marker strategy names no pid');
  assert.match(printed(inlineProbe('n0ff', false)), /<<<PROBE:n0ff:%s:%s>>>/, 'the typed probe prints the pid and the token');
  assert.match(inlineProbe('n0ff', false), /"\$\$" "\$\{__tsm_r-}"$/, 'posix: the token from the variable, unset-safe');
  assert.match(inlineProbe('n0ff', true), /\$fish_pid "\$__tsm_r"$/);
  const own = probeMark('n0ff').exec('<<<PROBE:n0ff:77:n0ff>>>')!;
  assert.deepEqual([own[1], own[2]], ['77', 'n0ff'], 'the inline strategy names the shell and its token');
  const nested = probeMark('n0ff').exec('<<<PROBE:n0ff:78:>>>')!;
  assert.deepEqual([nested[1], nested[2]], ['78', ''], 'a nested shell has no token');
  assert.equal(probeMark('n0ff').exec('<<<PROBE:n0ff:77>>>')![1], '77', 'the shape from before tokens still parses');
  assert.equal(startMark().test('<<<START:n0ff>>>'), false, 'the old shape, without a pid, is no start marker');
});

test('history is cut by shape as the live transcript cuts by nonce: wrapper echo, start line, end marker, probe, and nothing else', () => {
  const marker = ` command . '/tmp/tsm-501/abc/tsm-cmd-1'; echo "<<<EXI""T:74ef5182:$?>>>"\nMARKED-OUTPUT\n<<<EXIT:74ef5182:0>>>\nbash-3.2$ `;
  assert.equal(cutPlumbing(marker), 'MARKED-OUTPUT\n');
  const declared = `<<<START:74ef5182:4242>>>\nhello\n<<<EXIT:74ef5182:0>>>\nremote$ `;
  assert.equal(cutPlumbing(declared), 'hello\n', 'the start marker line, with its pid, goes');
  const typedStart = ` printf '<<<STAR''T:74ef5182:%s>>>\\n' "$$"; eval "$(printf '%b' "$__tsm_b")"; printf '<<<EXI''T:74ef5182:%s>>>\\n' "$?"\n<<<START:74ef5182:4242>>>\nhello\n<<<EXIT:74ef5182:0>>>\n`;
  assert.equal(cutPlumbing(typedStart), 'hello\n', 'the echo of the typed inline line goes too');
  const probed = 'OUT\n echo "<<<PRO""BE:74ef5182>>>"\n<<<PROBE:74ef5182>>>\nbash-3.2$ ';
  assert.equal(cutPlumbing(probed), 'OUT\n', 'from the probe echo on is plumbing');
  const probedInline = 'OUT\n printf \'<<<PRO\'\'BE:74ef5182:%s>>>\\n\' "$$"\n<<<PROBE:74ef5182:4242>>>\n';
  assert.equal(cutPlumbing(probedInline), 'OUT\n', 'the probe shape from before tokens, with no start marker to judge it by, ends the output');
  const coloured = '\x1b[31mA\x1b[0m\n<<<EXIT:74ef5182:0>>>\n';
  assert.equal(cutPlumbing(coloured), '\x1b[31mA\x1b[0m\n', 'the cut is made in the raw text, escapes kept');
  assert.equal(cutPlumbing('line one\nline two\n'), 'line one\nline two\n', 'nothing to cut');
});

const N = '74ef5182';
const typed = (nonce: string) => ` command . '/tmp/tsm-501/abc/tsm-cmd-1'; echo "<<<EXI""T:${nonce}:$?>>>"\n`;

test('with the nonce the Run recorded, a program line in a mark’s shape is output: only the Run’s own marks are cut', () => {
  const marker = { strategy: 'marker' as const, nonce: N };
  const plain = `${typed(N)}line1\nline2\nline3\n<<<EXIT:${N}:0>>>\nbash-3.2$ `;
  assert.equal(cutPlumbing(plain, marker), 'line1\nline2\nline3\n');
  // A program (history, a cat of a log) prints a line in the typed wrapper's shape, another Run's nonce.
  const echoShaped = `${typed(N)}line1\n${typed('0badf00d').trimStart()}line2\nline3\n<<<EXIT:${N}:0>>>\n`;
  assert.equal(cutPlumbing(echoShaped, marker), `line1\n${typed('0badf00d').trimStart()}line2\nline3\n`, 'the shaped line stays, and nothing before it is lost');
  assert.equal(cutPlumbing(echoShaped), `line1\n${typed('0badf00d').trimStart()}line2\nline3\n`, 'by shape alone (no nonce recorded) it is output too: only the lines at the head are the echo');
  // A running Run prints a line shaped like an end marker.
  const exitShaped = `${typed(N)}line1\n<<<EXIT:0badf00d:0>>>\nline3\n`;
  assert.equal(cutPlumbing(exitShaped, marker), 'line1\n<<<EXIT:0badf00d:0>>>\nline3\n', 'the Run is still running: nothing is cut after the echo');
  assert.equal(cutPlumbing(exitShaped), 'line1\n', 'by shape alone it ends the output');
  // A probe answer with the wrong nonce is a program's line too.
  assert.equal(cutPlumbing(`${typed(N)}A\n<<<PROBE:0badf00d>>>\nB\n`, marker), 'A\n<<<PROBE:0badf00d>>>\nB\n');
  // Rich: the output runs from the pre-execution mark to the end mark and holds no plumbing, whatever its shape.
  assert.equal(cutPlumbing(`<<<EXIT:${N}:0>>>\nkept\n`, { strategy: 'rich', nonce: N }), `<<<EXIT:${N}:0>>>\nkept\n`);
  // Basic: the first line is the echo of the typed line, unless the output was read from later.
  assert.equal(cutPlumbing(` . '/tmp/x/tsm-cmd-1'\r\nout\r\n`, { strategy: 'basic' }), 'out\r\n');
  assert.equal(cutPlumbing(`tail\r\n`, { strategy: 'basic', truncated: true }), 'tail\r\n');
});

test('a declared shell’s Run: its output begins after the start marker’s line; a probe answered by a nested shell is struck, not an end; the accepted probe ends it', () => {
  const inline = { strategy: 'inline' as const, nonce: N };
  // The live shape: the Run's output starts right after `>>>` of the start marker.
  assert.equal(cutPlumbing(`\r\nhello\r\n<<<EXIT:${N}:0>>>`, inline), 'hello\r\n');
  const echo = ` printf '<<<PRO''BE:${N}:%s:%s>>>\\n' "$$" "$\{__tsm_r-}"`;
  // The declared sh (pid 1000) started a nested sh (pid 2000). ^C and ^\ reached the nested shell's
  // prompt; both probes were answered by it, with its pid and no token; later a typed line ran
  // there, it exited, and the declared shell printed the Run's end marker.
  const nested = `\r\n$ ^C\r\n$ ${echo}\r\n<<<PROBE:${N}:2000:>>>\r\n$ ^\\\r\n$ ${echo}\r\n<<<PROBE:${N}:2000:>>>\r\n$ echo after-probe-$((7*6))\r\nafter-probe-42\r\n$ exit\r\n<<<EXIT:${N}:0>>>`;
  assert.equal(cutPlumbing(nested, inline), `$ ^C\r\n$ ^\\\r\n$ echo after-probe-$((7*6))\r\nafter-probe-42\r\n$ exit\r\n`);
  // No token and a pid the output does not vouch for (no start marker here): struck.
  assert.equal(cutPlumbing(`\r\nA\r\n$ ${echo}\r\n<<<PROBE:${N}:1000:>>>\r\nB\r\n`, inline), 'A\r\nB\r\n');
  // No token with the very pid the start marker named: the declared shell was replaced in place (an exec), and that shell answers for the Run.
  assert.equal(cutPlumbing(`<<<START:${N}:1000>>>\r\nA\r\n$ ${echo}\r\n<<<PROBE:${N}:1000:>>>\r\nB\r\n`, inline), 'A\r\n');
  assert.equal(cutPlumbing(`\r\nA\r\n$ ${echo}\r\n<<<PROBE:${N}:1000:>>>\r\nB\r\n`, { ...inline, pid: '1000' }), 'A\r\n', 'the live transcript knows the pid without the marker');
  // The declared shell's own answer carries the token: the output ends at its echo line.
  assert.equal(cutPlumbing(`\r\nA\r\n$ ${echo}\r\n<<<PROBE:${N}:2000:>>>\r\nB\r\n$ ${echo}\r\n<<<PROBE:${N}:1000:${N}>>>\r\n$ `, inline), 'A\r\nB\r\n');
  // An accepted answer whose echo was not shown (echo off), after a rejected probe: the cut is at the answer, the rejected lines struck.
  assert.equal(cutPlumbing(`\r\nA\r\n$ ${echo}\r\n<<<PROBE:${N}:2000:>>>\r\nB\r\n<<<PROBE:${N}:1000:${N}>>>\r\n`, inline), 'A\r\nB\r\n');
  // A probe nothing answered (a program read it) leaves its echo: struck; the Run's natural end still ends the output.
  assert.equal(cutPlumbing(`\r\nA\r\n$ ${echo}\r\nB\r\n<<<EXIT:${N}:3>>>`, inline), 'A\r\nB\r\n');
  // From before tokens, the start marker's pid judges the answers when the output holds it.
  const old = `<<<START:${N}:1000>>>\r\nA\r\n<<<PROBE:${N}:2000>>>\r\nB\r\n<<<PROBE:${N}:1000>>>\r\n`;
  assert.equal(cutPlumbing(old, inline), 'A\r\nB\r\n');
  assert.equal(cutPlumbing(old), 'A\r\nB\r\n', 'by shape too: the start marker is in the output');
  // The marker strategy's probe names no pid: always the session's own shell.
  assert.equal(cutPlumbing(`${typed(N)}A\n echo "<<<PRO""BE:${N}>>>"\n<<<PROBE:${N}>>>\n$ `, { strategy: 'marker', nonce: N }), 'A\n');
});

test('a typed line the editor redrew in pieces, its nonce split, is still cut whole', () => {
  // bash 3.2 as /bin/sh at 80 columns: the typed line is longer than the terminal, readline shows its
  // tail first, then the line again, and the nonce never appears whole in the echo (a real session's
  // output, which the cut by nonce alone left in the result).
  const raw = `sh$  . '/tmp/t/tsm-cmd-2'; echo "<<<EXI""T:f3e7c64\r\nc:$?>>>" . '/tmp/t/tsm-cmd-2'; echo "<<<EXI""T:f3e7c64\nafter\n<<<EXIT:f3e7c64c:0>>>\nsh$ `;
  assert.equal(cutPlumbing(raw, { strategy: 'marker', nonce: 'f3e7c64c' }), 'after\n');
});

test('a probe that went unanswered (a program ignoring ^C read it) leaves only its echo struck: the output printed after it stays, up to the accepted answer', () => {
  // The house's read of 78c4d6e (#22): the cut moved back to the earliest unanswered echo, and the output after it was gone.
  const inline = { strategy: 'inline' as const, nonce: N };
  const echo = ` printf '<<<PRO''BE:${N}:%s:%s>>>\\n' "$$" "$\{__tsm_r-}"`;
  // The session's own cancel sequence: ^C, a probe the program read as input (echoed, unanswered), more output,
  // ^\ ends the program, the second probe is answered by the shell.
  const run = `\r\nout1\r\n^C\r\n${echo}\r\nout2\r\n^\\\r\n$ ${echo}\r\n<<<PROBE:${N}:1000:${N}>>>\r\n$ `;
  assert.equal(cutPlumbing(run, inline), 'out1\r\n^C\r\nout2\r\n^\\\r\n');
  // The second probe's echo missing (echo off): the output ends at the answer, the first echo struck.
  assert.equal(cutPlumbing(`\r\nout1\r\n^C\r\n${echo}\r\nout2\r\n<<<PROBE:${N}:1000:${N}>>>\r\n`, inline), 'out1\r\n^C\r\nout2\r\n');
  // The marker strategy's probe line, the same way.
  const typedProbe = ` echo "<<<PRO""BE:${N}>>>"`;
  assert.equal(cutPlumbing(`${typed(N)}out1\n^C\n${typedProbe}\nout2\n^\\\n${typedProbe}\n<<<PROBE:${N}>>>\n$ `, { strategy: 'marker', nonce: N }), 'out1\n^C\nout2\n^\\\n');
  // Live, by the pid the transcript knows: the same.
  assert.equal(cutPlumbing(`\r\nA\r\n${echo}\r\nB\r\n$ ${echo}\r\n<<<PROBE:${N}:1000:>>>\r\n`, { ...inline, pid: '1000' }), 'A\r\nB\r\n');
});

test('a typed line the editor wraps inside its nonce is still cut: bash 5.2 at a narrow width writes the margin character again after a carriage return', () => {
  // The house's read of 78c4d6e (#22): at 26 columns the probe line's echo held `a1b2c\rc3d4`, and the line stayed in the output.
  const nonce = 'a1b2c3d4';
  const inline = { strategy: 'inline' as const, nonce };
  const echo = ` printf '<<<PRO''BE:a1b2c\rc3d4:%s:%s>>>\\n' "$$" "$\{__tsm_r-}"`;
  assert.equal(cutPlumbing(`\r\nout\r\n^C\r\n$ ${echo}\r\n<<<PROBE:${nonce}:1000:${nonce}>>>\r\n$ `, inline), 'out\r\n^C\r\n');
  // The wrapper's own echo, wrapped the same way, in the inline and the marker strategies.
  const typedStart = ` printf '<<<STAR''T:a1b2c\rc3d4:%s>>>\\n' "$$"; eval "$(printf '%b' "$__tsm_b")"; printf '<<<EXI''T:a1b2c\rc3d4:%s>>>\\n' "$?"\r\n<<<START:${nonce}:4242>>>\r\nhello\r\n<<<EXIT:${nonce}:0>>>\r\n`;
  assert.equal(cutPlumbing(typedStart, inline), 'hello\r\n');
  const marker = ` command . '/tmp/t/tsm-cmd-1'; echo "<<<EXI""T:a1b2c\rc3d4:$?>>>"\r\nout\r\n<<<EXIT:${nonce}:0>>>\r\n`;
  assert.equal(cutPlumbing(marker, { strategy: 'marker', nonce }), 'out\r\n');
  // A wrap at the margin inside the split word, with a blank before the carriage return (readline's form).
  const inWord = ` echo "<<<EXI""T \r T:${nonce}:$?>>>"\r\nout\r\n<<<EXIT:${nonce}:0>>>\r\n`;
  assert.equal(cutPlumbing(inWord, { strategy: 'marker', nonce }), 'out\r\n');
  // The printed marks are never taken for echoes: the allowance adds nothing to `EXIT`.
  assert.equal(cutPlumbing(`${typed(nonce)}<<<EXIT:${nonce}:0>>>\n`, { strategy: 'marker', nonce }), '');
});

test('a probe answer with the Run’s token from another pid is a stranger’s: the pid the start marker named judges first, then the token', () => {
  // The house's read of 78c4d6e (#22, comment 6269901528): with `set -a` in a declared sh, a nested sh inherited the
  // token and answered with its own pid; the session rejected it and the Run went on, but the cutter ended the result there.
  const inline = { strategy: 'inline' as const, nonce: N };
  const echo = ` printf '<<<PRO''BE:${N}:%s:%s>>>\\n' "$$" "$\{__tsm_r-}"`;
  const history = `<<<START:${N}:1000>>>\r\nA\r\n$ ^C\r\n$ ${echo}\r\n<<<PROBE:${N}:2000:${N}>>>\r\n$ echo after\r\nafter\r\n$ exit\r\n<<<EXIT:${N}:0>>>\r\n`;
  assert.equal(cutPlumbing(history, inline), 'A\r\n$ ^C\r\n$ echo after\r\nafter\r\n$ exit\r\n');
  // Live, by the pid the session knows: the same.
  assert.equal(cutPlumbing(`\r\n$ ^C\r\n$ ${echo}\r\n<<<PROBE:${N}:2000:${N}>>>\r\n$ echo after\r\nafter\r\n$ exit\r\n<<<EXIT:${N}:0>>>`, { ...inline, pid: '1000' }), '$ ^C\r\n$ echo after\r\nafter\r\n$ exit\r\n');
  // The declared shell's own pid with the token, or with none (replaced in place), still ends it.
  assert.equal(cutPlumbing(`<<<START:${N}:1000>>>\r\nA\r\n$ ${echo}\r\n<<<PROBE:${N}:1000:${N}>>>\r\nB\r\n`, inline), 'A\r\n');
  assert.equal(cutPlumbing(`<<<START:${N}:1000>>>\r\nA\r\n$ ${echo}\r\n<<<PROBE:${N}:1000:>>>\r\nB\r\n`, inline), 'A\r\n');
  // That pid with another Run's token is a stranger's too.
  assert.equal(cutPlumbing(`<<<START:${N}:1000>>>\r\nA\r\n$ ${echo}\r\n<<<PROBE:${N}:1000:0badf00d>>>\r\nB\r\n`, inline), 'A\r\nB\r\n');
  // With no pid known (a read from after the start marker, no live pid), the token is the one evidence, as before.
  assert.equal(cutPlumbing(`\r\nA\r\n$ ${echo}\r\n<<<PROBE:${N}:2000:${N}>>>\r\nB\r\n`, inline), 'A\r\n');
});

test('a wrapper-shaped line in a Run’s output is output: only the echo lines at the output’s head are the typed line', () => {
  // The house's read of 78c4d6e (#22, comment 6269901528): in a declared bash, `echo before-$((1+1)); history 1` returned
  // an empty result, because `history 1` printed the typed line with the Run's own nonce and the cut took it for the echo.
  const inline = { strategy: 'inline' as const, nonce: N };
  const typedStart = ` printf '<<<STAR''T:${N}:%s>>>\\n' "$$"; eval "$(printf '%b' "$__tsm_b")"; printf '<<<EXI''T:${N}:%s>>>\\n' "$?"`;
  const recalled = `  502 ${typedStart}`;
  // Live: the Run's output begins after the start marker.
  assert.equal(cutPlumbing(`\r\nbefore-2\r\n${recalled}\r\n<<<EXIT:${N}:0>>>`, inline), `before-2\r\n${recalled}\r\n`);
  // History: the echo line, the start marker, then the output with the recalled line in it.
  assert.equal(cutPlumbing(`${typedStart}\r\n<<<START:${N}:4242>>>\r\nbefore-2\r\n${recalled}\r\n<<<EXIT:${N}:0>>>\r\n`, inline), `before-2\r\n${recalled}\r\n`);
  // A shell still starting when the line was typed (ssh: the line echoed locally, then the login banner, then the
  // remote prompt showing the line again) prints all of that before the start marker: everything through the marker is the shell's.
  assert.equal(cutPlumbing(`${typedStart}\r\nLast login: today\r\n$ ${typedStart}\r\n<<<START:${N}:4242>>>\r\nbefore-2\r\n${recalled}\r\n<<<EXIT:${N}:0>>>\r\n`, inline), `before-2\r\n${recalled}\r\n`);
  // `history | tail -n 3` and `fc -l -1` print it among other lines, or with a tab.
  const tail3 = `  500  ls\r\n  501  cd /tmp\r\n  502 ${typedStart}`;
  assert.equal(cutPlumbing(`\r\nbefore-2\r\n${tail3}\r\n<<<EXIT:${N}:0>>>`, inline), `before-2\r\n${tail3}\r\n`);
  const fc = `502\t${typedStart}`;
  assert.equal(cutPlumbing(`\r\nbefore-2\r\n${fc}\r\n<<<EXIT:${N}:0>>>`, inline), `before-2\r\n${fc}\r\n`);
  // The marker strategy: the same shape from a shell's history is output after the echo line.
  const marker = { strategy: 'marker' as const, nonce: N };
  assert.equal(cutPlumbing(`${typed(N)}before-2\n  502 ${typed(N).trim()}\n<<<EXIT:${N}:0>>>\n$ `, marker), `before-2\n  502 ${typed(N).trim()}\n`);
  // The echo typed ahead of its prompt shows twice at the head: both lines are the typed line.
  assert.equal(cutPlumbing(`${typed(N)}$ ${typed(N)}out\n<<<EXIT:${N}:0>>>\n`, marker), 'out\n');
  // Nothing but the echo (a Run cut off before any output) is no output.
  assert.equal(cutPlumbing(typed(N).trimEnd(), marker), '');
});

test('under the marker strategy the echo begins at the Run’s first wrapper echo wherever it is: what comes before it is the shell’s', () => {
  // The house's read of the 38 commits (#22, comment 6274773484): with a banner line or an empty line before the echo, the
  // rule that took the echo only on the output's first line kept the echo in the output.
  const marker = { strategy: 'marker' as const, nonce: N };
  assert.equal(cutPlumbing(`Last login: today\n${typed(N)}out\n<<<EXIT:${N}:0>>>\n$ `, marker), 'out\n', 'a banner before the echo');
  assert.equal(cutPlumbing(`\r\n${typed(N)}out\n<<<EXIT:${N}:0>>>\n`, marker), 'out\n', 'an empty line before the echo');
  assert.equal(cutPlumbing(`$ ${typed(N)}$ ${typed(N)}out\n<<<EXIT:${N}:0>>>\n`, marker), 'out\n', 'a prompt on the echo’s line, the echo shown twice');
  // A typed line wrapped before its marker: its head is on the line before the first echo, and goes with what precedes it.
  assert.equal(cutPlumbing(` command . '/var/folders/x/T/tsm-501/abc/tsm-cmd-1'; e\r\ncho "<<<EXI""T:${N}:$?>>>"\r\nout\r\n<<<EXIT:${N}:0>>>\r\n`, marker), 'out\r\n');
  // Lines after the echo region are the program's, the echo's shape included.
  assert.equal(cutPlumbing(`banner\n${typed(N)}before-2\n  502 ${typed(N).trim()}\n<<<EXIT:${N}:0>>>\n`, marker), `before-2\n  502 ${typed(N).trim()}\n`);
  // A shell still starting when the line was typed shows it again after its banner: that second echo is in the echo's shape
  // after output, which the rule cannot tell from a program's, so it stays when no start mark bounds the output (a journal
  // from before the command file printed one; the next test has the mark).
  assert.equal(cutPlumbing(`${typed(N)}Welcome to fish\n$ ${typed(N)}first\n<<<EXIT:${N}:0>>>\n`, marker), `Welcome to fish\n$ ${typed(N)}first\n`);
  // A read that began after the Run's start holds no echo of its own: an echo-shaped line there is the program's.
  assert.equal(cutPlumbing(`tail of out\n  502 ${typed(N).trim()}\nmore\n`, { ...marker, truncated: true }), `tail of out\n  502 ${typed(N).trim()}\nmore\n`);
  // Under inline the output begins after the start marker, past the echo: an echo-shaped line in it is the program's.
  const inline = { strategy: 'inline' as const, nonce: N };
  const typedStart = ` printf '<<<STAR''T:${N}:%s>>>\\n' "$$"; eval "$(printf '%b' "$__tsm_b")"; printf '<<<EXI''T:${N}:%s>>>\\n' "$?"`;
  assert.equal(cutPlumbing(`\r\nbefore-2\r\n${typedStart}\r\n<<<EXIT:${N}:0>>>`, inline), `before-2\r\n${typedStart}\r\n`);
});

test('a probe’s echo broken over two lines is struck on every line it spans, through the end of the typed line', () => {
  // The house's read of the 38 commits (#22, comment 6274773484): only the line where the match began was struck, so
  // `c3d4:%s:%s>>>\n' …` stayed in the output.
  const nonce = 'a1b2c3d4';
  const inline = { strategy: 'inline' as const, nonce };
  const probe = inlineProbe(nonce, false);
  const brokenInNonce = probe.replace('a1b2', () => 'a1b2\r\n');
  assert.equal(cutPlumbing(`\r\nout\r\n^C\r\n$${brokenInNonce}\r\n<<<PROBE:${nonce}:1000:${nonce}>>>\r\n$ `, inline), 'out\r\n^C\r\n');
  // Broken after the nonce, or between the format and its arguments: the rest of the typed line is struck too.
  const afterNonce = probe.replace(`${nonce}:`, () => `${nonce}\r\n:`);
  assert.equal(cutPlumbing(`\r\nout\r\n^C\r\n$${afterNonce}\r\n<<<PROBE:${nonce}:1000:${nonce}>>>\r\n$ `, inline), 'out\r\n^C\r\n');
  const inArgs = probe.replace(`' "$$"`, () => `'\r\n "$$"`);
  assert.equal(cutPlumbing(`\r\nout\r\n^C\r\n$${inArgs}\r\nmore\r\n<<<EXIT:${nonce}:0>>>`, inline), 'out\r\n^C\r\nmore\r\n', 'an unanswered probe: its echo struck, the output after it kept');
  const fish = inlineProbe(nonce, true).replace('$fish_pid', () => '\r\n$fish_pid');
  assert.equal(cutPlumbing(`\r\nout\r\n${fish}\r\nmore\r\n<<<EXIT:${nonce}:0>>>`, inline), 'out\r\nmore\r\n', 'fish’s probe line');
  const marker = { strategy: 'marker' as const, nonce };
  assert.equal(cutPlumbing(`${typed(nonce)}out\n echo "<<<PRO""BE:a1b2\r\nc3d4>>>"\nmore\n<<<EXIT:${nonce}:0>>>\n`, marker), 'out\nmore\n', 'the marker strategy’s probe line');
});

test('history judges a probe answer by the shell pid the Run’s run.start recorded, as the live transcript does', async () => {
  // The house's read of the 38 commits (#22, comment 6274773484): history passed the cutter no pid (the start marker's chunk
  // is journaled outside the Run's output), so a nested shell answering with the Run's inherited token ended the result.
  const echo = ` printf '<<<PRO''BE:${N}:%s:%s>>>\\n' "$$" "$\{__tsm_r-}"`;
  const data = `\r\n$ ^C\r\n$ ${echo}\r\n<<<PROBE:${N}:2000:${N}>>>\r\n$ echo after\r\nafter\r\n$ exit\r\n<<<EXIT:${N}:0>>>\r\n`;
  const o = { events: [{ type: 'output', seq: 5, ts: 0, stream: 'pty', data, runId: 'r1' }], from: 5, to: 5, truncated: false } as unknown as RunOutput;
  const run = { runId: 'r1', target: 'shell', strategy: 'inline', nonce: N } as unknown as RunInfo;
  assert.match((await journalRunText(o, { cols: 80, rows: 24 }, { ...run, shellPid: 1000 })).text, /after/, 'the recorded pid rejects the stranger');
  assert.doesNotMatch((await journalRunText(o, { cols: 80, rows: 24 }, run)).text, /after/, 'a Run journaled before the pid was: the token is the one evidence');
});

test('a reviewer’s read (6270045466): nonceOf names the nonce a printed mark carries, and nothing for text that is no mark', () => {
  assert.equal(nonceOf('<<<EXIT:74ef5182:0>>>'), '74ef5182');
  assert.equal(nonceOf('<<<PROBE:74ef5182>>>'), '74ef5182');
  assert.equal(nonceOf('<<<PROBE:74ef5182:4242:74ef5182>>>'), '74ef5182');
  assert.equal(nonceOf('<<<START:74ef5182:4242>>>'), '74ef5182');
  assert.equal(nonceOf(`echo "<<<EXI""T:74ef5182:$?>>>"`), undefined, 'the typed echo is split so it is no mark');
  assert.equal(nonceOf('plain output'), undefined);
  assert.equal(nonceOf(`. '/tmp/x/tsm-cmd-1'`), undefined);
});

test('the probe lines the session types are the ones the grammar parses and the cutter strikes: what a shell prints for each is its mark, and its echo, broken anywhere, goes whole', () => {
  // A reviewer's read of the fixes for #22: the cutter's copy of the probe lines' rests was written by hand beside the
  // session's builders, and no spec tied them. The builders now live beside the grammar, the cutter's echo is taken from
  // them, and this runs each line in a shell and breaks its echo at every point from its mark on.
  const nonce = 'a1b2c3d4';
  const fish = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find((p) => fs.existsSync(p));
  const lines = [
    { name: 'marker', line: markerProbe(nonce), of: { strategy: 'marker' as const, nonce }, shell: '/bin/sh', set: '' },
    { name: 'inline sh', line: inlineProbe(nonce, false), of: { strategy: 'inline' as const, nonce }, shell: '/bin/sh', set: `__tsm_r=${nonce};` },
    { name: 'inline fish', line: inlineProbe(nonce, true), of: { strategy: 'inline' as const, nonce }, shell: fish, set: `set -g __tsm_r ${nonce};` },
  ];
  for (const { name, line, of, shell, set } of lines) {
    assert.equal(probeMark(nonce).test(line), false, `${name}: the typed line is no mark`);
    if (shell) {
      const m = probeMark(nonce).exec(execFileSync(shell, ['-c', `${set}${line}`], { encoding: 'utf8' }));
      assert.ok(m, `${name}: what the shell prints is the mark`);
      if (of.strategy === 'marker') assert.deepEqual([m[1], m[2]], [undefined, undefined], `${name}: no pid, no token`);
      else assert.ok(/^\d+$/.test(m[1]!) && m[2] === nonce, `${name}: the shell's pid and the Run's token: ${m[0]}`);
    }
    const head = of.strategy === 'marker' ? `${typed(nonce)}out\n` : '\r\nout\r\n';
    const tail = of.strategy === 'marker' ? `\nmore\n<<<EXIT:${nonce}:0>>>\n` : `\r\nmore\r\n<<<EXIT:${nonce}:0>>>`;
    const want = of.strategy === 'marker' ? 'out\nmore\n' : 'out\r\nmore\r\n';
    for (let i = line.indexOf('<<<') + 1; i < line.length; i++) {
      const broken = `${line.slice(0, i)}\r\n${line.slice(i)}`;
      assert.equal(cutPlumbing(`${head}${broken}${tail}`, of), want, `${name}: broken at ${i}: ${JSON.stringify(broken)}`);
    }
    // The matcher a reader without the nonce uses (the compat pack's logs) takes the whole line for any Run's.
    assert.equal([...line.matchAll(probeEcho())][0]?.[0], line.slice(line.indexOf('<<<')), `${name}: with no nonce, the line from its mark to its end`);
  }
});

test('every line the inline strategy types is the typed-line echo whole, and the marks its pieces print are the grammar’s', () => {
  // The compat pack's logs cut a declared shell's typed lines by this one shape, where its own copy of the
  // marker strategy's shapes had left them in (a reviewer's read of the fixes for #22): heads that drift
  // from inlineLines would leave a body in the logs again.
  const whole = new RegExp(`^(?:${inlineTypedLine().source})$`);
  for (const fish of [false, true]) {
    for (const body of ['echo hi', `echo ${'x'.repeat(3000)}`]) {
      const typed = inlineLines(body, 'n0ff', fish);
      if (body.length > 1000) assert.ok(typed.length > 2, 'a long body goes in pieces');
      typed.forEach((line, i) => {
        assert.match(line, whole, `fish ${fish}, line ${i}: ${line.slice(0, 60)}`);
        assert.match(`sh-3.2$ ${line}`, inlineTypedLine(), 'after a prompt too');
        assert.match(printed(line), goneMark('n0ff'), 'every line prints the gone mark when the text so far is not whole');
        if (i < typed.length - 1) assert.equal(ackMark('n0ff').exec(printed(line))?.[1], String(i + 1), 'a piece prints its acknowledgement');
      });
    }
  }
  assert.equal(nonceOf('<<<ACK:n0ff:2>>>'), 'n0ff');
  assert.equal(nonceOf('<<<GONE:n0ff>>>'), 'n0ff');
  for (const line of ['__tsm_b is a name', 'echo done', ' set -g PATH /bin']) assert.doesNotMatch(line, inlineTypedLine(), line);
});

test('the line that runs a command file, for each flavor, with the marker strategy’s end mark and without, is the echo compat cuts and the one the cutter takes for the Run’s echo', () => {
  // compat kept a hand copy of these lines, with no line for fish's marker strategy; it is now derived from
  // the session's own builder (a reviewer's read of the fixes for #22).
  const file = `/tmp/it's here/${commandFile(12)}`;
  assert.equal(shellQuote(file), `'/tmp/it'\\''s here/tsm-cmd-12'`);
  const whole = new RegExp(`^(?:${sourceLineEcho().source})$`);
  for (const flavor of ['posix', 'zsh', 'fish'] as const) {
    for (const nonce of [undefined, 'n0ff']) {
      const line = sourceLine(file, flavor, nonce);
      const what = `${flavor}, ${nonce ? 'marker' : 'integrated'}: ${line}`;
      assert.match(line, whole, what);
      assert.equal(`bash-3.2$ ${line}`.replace(sourceLineEcho(), '').trimEnd(), 'bash-3.2$', `after a prompt, the whole line: ${what}`);
      if (nonce) {
        // The marker strategy's Run output begins with the echo: the cutter takes it by the split end mark it carries,
        // printed by printf (in dash, bash and zsh in a group whose trace goes nowhere).
        assert.match(line, flavor === 'fish' ? /; printf '%s:%s>>>\\n' "<<<EXI""T:n0ff" \$status$/ : /; \{ printf '%s:%s>>>\\n' "<<<EXI""T:n0ff" "\$\?"; \} 2>\/dev\/null$/, what);
        assert.equal(cutPlumbing(`${line}\r\nout\r\n<<<EXIT:n0ff:0>>>\r\n`, { strategy: 'marker', nonce }), 'out\r\n', what);
        // The line an earlier build typed, which journals keep, is still the echo.
        const legacy = line.replace(/; .*$/, `; echo "<<<EXI""T:n0ff:${flavor === 'fish' ? '$status' : '$?'}>>>"`);
        assert.match(legacy, whole, `legacy: ${what}`);
        assert.equal(cutPlumbing(`${legacy}\r\nout\r\n<<<EXIT:n0ff:0>>>\r\n`, { strategy: 'marker', nonce }), 'out\r\n', `legacy: ${what}`);
      } else {
        // Under `basic` the output's first line is the echo.
        assert.equal(cutPlumbing(`${line}\r\nout\r\n`, { strategy: 'basic' }), 'out\r\n', what);
      }
    }
  }
  assert.equal(sourceLine(file, 'posix', 'n0ff').startsWith(' command . '), true, 'POSIX under the marker strategy: `command .`');
  assert.equal(sourceLine(file, 'zsh', 'n0ff').startsWith(' . '), true, 'zsh: `.`');
  for (const line of ['. ./setup.sh', 'source ~/.bashrc', ` . '/tmp/x/other-12'`]) assert.doesNotMatch(line, sourceLineEcho(), line);
});

test('no pattern the grammar builds backtracks: every typed line, cut anywhere and followed by a long run of spaces or of its next character, reads in time linear in the line', () => {
  // The house's read of the 33 commits (#22, comment 6307351104): the typed probe line through its `\n'`, then 3,200 spaces and
  // a character the pattern did not expect, took one probeEcho().exec 9.35 s, on output any program prints.
  const nonce = 'a1b2c3d4';
  const file = `/tmp/x/${commandFile(3)}`;
  const lines = [
    markerProbe(nonce),
    markerProbe(nonce, 'fish'),
    inlineProbe(nonce, false),
    inlineProbe(nonce, true),
    ...(['posix', 'zsh', 'fish'] as const).flatMap((f) => [sourceLine(file, f, nonce), sourceLine(file, f)]),
    ...inlineLines('echo hi', nonce, false),
    ...inlineLines('echo hi', nonce, true),
  ];
  const readers: Array<[string, (s: string) => unknown]> = [
    ['probeEcho()', (s) => [...s.matchAll(probeEcho())]],
    ['probeEcho(nonce)', (s) => [...s.matchAll(probeEcho(nonce))]],
    ['sourceLineEcho', (s) => sourceLineEcho().exec(s)],
    ['inlineTypedLine', (s) => inlineTypedLine().exec(s)],
    ['the marker cutter', (s) => cutPlumbing(s, { strategy: 'marker', nonce })],
    ['the inline cutter', (s) => cutPlumbing(s, { strategy: 'inline', nonce })],
    ['the cutter by shape', (s) => cutPlumbing(s)],
  ];
  let worst = { ms: 0, what: '' };
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      for (const fill of [' ', line[i]!]) {
        const s = `${line.slice(0, i)}${fill.repeat(2000)}\u0001`;
        for (const [name, read] of readers) {
          const t = performance.now();
          read(s);
          const ms = performance.now() - t;
          if (ms > worst.ms) worst = { ms, what: `${name} on ${JSON.stringify(line.slice(0, i))} and 2,000 × ${JSON.stringify(fill)}` };
        }
      }
    }
  }
  // Seconds each on the old pattern; a millisecond or two now, and the bound leaves room for a loaded machine.
  assert.ok(worst.ms < 250, `${worst.what}: ${Math.round(worst.ms)} ms`);
});

test('under the marker strategy the start mark the command file prints bounds the output: whatever came before it is the shell’s, an echo-shaped line after it is the program’s', () => {
  // The house's read of the 33 commits (#22, comment 6307351104), items 3, 6 and 8, and its answer 2.
  const marker = { strategy: 'marker' as const, nonce: N };
  const mark = `<<<START:${N}:4242>>>\r\n`;
  // 3: with the echo off nothing echoes before the mark, and `fc -l -1` prints the typed line after the output began: the
  // rule that let it stand for the echo returned `out-2` alone.
  const fc = `6\t${typed(N).trim()}`;
  assert.equal(cutPlumbing(`sh-3.2$ ${mark}out-1\r\n${fc}\r\nout-2\r\n<<<EXIT:${N}:0>>>\r\nsh-3.2$ `, marker), `out-1\r\n${fc}\r\nout-2\r\n`);
  // 6: a shell still starting when the line was typed prints its banner and shows the line again, all before the mark.
  assert.equal(cutPlumbing(`${typed(N)}Welcome, slow shell\r\nsh-3.2$ ${typed(N)}${mark}first\r\n<<<EXIT:${N}:0>>>\r\n`, marker), 'first\r\n');
  // 8: a redraw that broke the typed line after the nonce's colon left `$?>>>"` at the head.
  const brokenAfterColon = typed(N).replace(`${N}:`, `${N}:\r\n`);
  assert.equal(cutPlumbing(`${brokenAfterColon}${mark}out\r\n<<<EXIT:${N}:0>>>\r\n`, marker), 'out\r\n');
  // A file that never ran prints no mark: the echo is cut by the rule that held before, through the end of the typed line.
  assert.equal(cutPlumbing(`${brokenAfterColon}read by a program\r\n<<<EXIT:${N}:0>>>\r\n`, marker), 'read by a program\r\n');
  assert.equal(cutPlumbing(`${typed(N).replace('$?', '$\r\n?')}read by a program\r\n`, marker), 'read by a program\r\n', 'broken later in the rest');
  // Another Run's start mark is no bound: the echo rule holds.
  assert.equal(cutPlumbing(`${typed(N)}<<<START:0badf00d:4242>>>\r\nout\r\n`, marker), '<<<START:0badf00d:4242>>>\r\nout\r\n');
});

/** Shells to run the marker strategy's lines in, each with its flavor and how it turns tracing on with a PS4 of its own. */
const FISH = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find((p) => fs.existsSync(p));
const MARKER_SHELLS = [
  { shell: '/bin/dash', flavor: 'posix' as const, trace: "PS4='>> '; set -x; ", status: '$?' },
  { shell: '/bin/bash', flavor: 'posix' as const, trace: "PS4='>> '; set -x; ", status: '$?' },
  { shell: '/bin/zsh', flavor: 'zsh' as const, trace: "PS4='>> '; set -x; ", status: '$?' },
  { shell: FISH, flavor: 'fish' as const, trace: 'set fish_trace 1; ', status: '$status' },
].filter((x): x is typeof x & { shell: string } => x.shell !== undefined && fs.existsSync(x.shell));
/** A script run by `shell -c`, its stderr (where every shell writes its trace) joined to its output. */
const runMerged = (shell: string, script: string): string => execFileSync('/bin/sh', ['-c', 'exec "$0" -c "$1" 2>&1', shell, script], { encoding: 'utf8' });

test('the marker strategy’s end mark and probe are printf-built: no `set -x` trace holds a whole mark, dash, bash and zsh trace neither, and the result ends at the real mark whatever PS4 is', () => {
  // The house's review of the 40 commits through f3750e4 (PR #22, comment 6310921374), question 2 and the cutter's "left for
  // later": dash traced the chained echo as the end mark itself, so the Run ended at the trace; a body that set PS4, or whose
  // output had no line end before the trace, kept the trace's head (`>> echo `, `abc+ echo `).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-printf-mark-'));
  try {
    assert.ok(MARKER_SHELLS.length >= 3);
    for (const { shell, flavor, trace } of MARKER_SHELLS) {
      const what = path.basename(shell);
      // A command file's own name: the typed line's trace is known by it.
      fs.mkdirSync(path.join(dir, what));
      const file = path.join(dir, what, commandFile(1));
      for (const [head, body, shown] of [
        [trace, 'echo hi\nprintf abc\n', flavor === 'fish' ? /^--> echo hi\nhi\n--> printf abc\nabc$/ : /^(>+ )echo hi\nhi\n\1printf abc\nabc$/],
        ['', flavor === 'fish' ? 'set fish_trace 1\necho on\n' : "PS4='[t] '; set -x\necho on\n", flavor === 'fish' ? /^--> echo on\non\n$/ : /^\[+t\] echo on\non\n$/],
      ] as const) {
        fs.writeFileSync(file, markerCommandText(body, N, flavor));
        const out = runMerged(shell, `${head}false; ${sourceLine(file, flavor, N).trimStart()}; ${markerProbe(N, flavor).trimStart()}`);
        const said = `${what} ${JSON.stringify(head)}: ${JSON.stringify(out)}`;
        assert.deepEqual([...out.matchAll(new RegExp(exitMark(N).source, 'g'))].map((m) => m[1]), ['0'], `one end mark, the real one: ${said}`);
        assert.equal([...out.matchAll(new RegExp(probeMark(N).source, 'g'))].length, 1, `one probe answer: ${said}`);
        if (flavor !== 'fish') assert.doesNotMatch(out, /printf[^\n]*<<<(?:EXIT|PROBE)/, `neither traced: ${said}`);
        else if (head) assert.match(out, /abc> printf '%s:%s>>>\\\\n' '<<<EXIT:[^']*' 0\n/, `fish traces past the redirect: ${said}`);
        assert.match(cutPlumbing(out, { strategy: 'marker', nonce: N }), shown, said);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a trace a shell writes past the typed line’s redirect is named by the Run’s nonce: from the prefix the typed line’s trace showed, or else its whole line; a program’s lines in its shape stay', () => {
  // fish writes its trace past any redirect, and bash does to a BASH_XTRACEFD; the trace of the printf-built mark holds none.
  const marker = { strategy: 'marker' as const, nonce: N };
  const mark = `<<<START:${N}:4242>>>\r\n`;
  const end = `<<<EXIT:${N}:0>>>\r\n`;
  const file = '/tmp/tsm-501/abc/tsm-cmd-1';
  const echo = `${sourceLine(file, 'fish', N)}\r\n`;
  const fishTrace = `printf '%s:%s>>>\\\\n' '<<<EXIT:${N}' 0\r\n`;
  assert.equal(cutPlumbing(`${echo}> source ${file}\r\n${mark}--> printf abc\r\nabc> ${fishTrace}${end}`, marker), '--> printf abc\r\nabc', 'the typed line’s trace showed the prefix: output with no line end stays');
  assert.equal(cutPlumbing(`${echo}${mark}--> echo on\r\non\r\n> ${fishTrace}${end}`, marker), '--> echo on\r\non\r\n', 'the body turned tracing on: the trace’s line');
  assert.equal(cutPlumbing(`${echo}${mark}--> printf abc\r\nabc> ${fishTrace}${end}`, marker), '--> printf abc\r\nabc', 'fish’s own prefix, which its trace’s doubled backslash shows');
  assert.equal(cutPlumbing(`${echo}${mark}on\r\n[t] printf %s:%s>>>\\n <<<EXIT:${N} 0\r\n${end}`, marker), 'on\r\n', 'a PS4 of the body’s own, in dash’s shape');
  const probe = `^C\r\n$ ${markerProbe(N, 'fish').trimStart()}\r\n> printf '%s>>>\\\\n' '<<<PROBE:${N}'\r\n<<<PROBE:${N}>>>\r\n$ `;
  assert.equal(cutPlumbing(`${echo}${mark}out\r\n${probe}`, marker), 'out\r\n^C\r\n', 'the probe’s trace before its answer');
  // Not traces: the echo that printed the mark in earlier builds traced as the mark itself, and the guess at that trace's head
  // cut a program's own line that ended in `echo `; another Run's nonce names nothing.
  assert.equal(cutPlumbing(`${echo}${mark}+ echo ${end}`, marker), '+ echo ', 'a program’s `+ echo ` before the mark');
  const other = `printf '%s:%s>>>\\n' '<<<EXIT:0badf00d' 0\r\n`;
  assert.equal(cutPlumbing(`${echo}${mark}${other}${end}`, marker), other, 'another Run’s nonce');
});

test('the marker strategy’s start line prints the Run’s start mark with the shell’s pid, keeps the status the shell had for the body, leaves no temporary behind, ends no shell under set -e, and traces nothing after the mark', () => {
  // The house's answer 2 on the 33 commits (#22, comment 6307351985): `$?` after `false` is still 1 in the body. The house's review
  // of the 40 commits through f3750e4 (PR #22, comment 6310921374): `__tsm_q` stayed set in the user's shell, and after
  // `set -e; ! true` a body of only comments ended the shell, the start line's group being the file's last command.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-start-line-'));
  try {
    assert.ok(MARKER_SHELLS.length >= 3);
    for (const { shell, flavor, status, trace } of MARKER_SHELLS) {
      const what = path.basename(shell);
      const file = path.join(dir, `${what}-${commandFile(1)}`);
      const dot = sourceLine(file, flavor, N).trimStart().replace(/;.*$/, '');
      const left = flavor === 'fish' ? 'echo "q=[$__tsm_q]"; functions -q __tsm_start; and echo leaked-function; true' : 'echo "q=[${__tsm_q-}]"';
      const run = (head: string, body: string) => {
        fs.writeFileSync(file, markerCommandText(body, N, flavor));
        return runMerged(shell, `${head}${dot}; echo "<<<EXIT:${N}:${status}>>>"; ${left}`);
      };
      const body = `echo "body sees ${status}"\n`;
      const out = run('false; ', body);
      const m = startMark(N).exec(out);
      assert.ok(m && /^\d+$/.test(m[1]!), `${what}: the mark, with a pid: ${out}`);
      assert.match(out, /body sees 1\n<<<EXIT:[^:]+:0>>>\nq=\[\]\n$/, `${what}: the body saw the earlier status, and nothing is left: ${out}`);
      assert.match(run('true; ', body), /body sees 0/, what);
      assert.match(run('false; ', '\n  # only a comment\n\n'), /<<<START:[^\n]*\n<<<EXIT:[^:]+:0>>>\nq=\[\]\n$/, `${what}: a body of comments exits 0`);
      for (const head of [`${trace}false; `, `${trace}true; `]) {
        const after = run(head, 'echo traced\n').split('<<<START')[1]!;
        assert.match(after, /^:[^\n]*\n[^\n]*echo traced\ntraced\n/, `${what} ${head}: nothing of the start line is traced after the mark: ${after}`);
      }
      if (flavor === 'fish') continue;
      assert.match(run('set -e; ! true; ', body), /body sees 1\n<<<EXIT/, `${what}: set -e kept the shell`);
      assert.match(run('set -e; ! true; ', '# a comment\n'), /<<<EXIT:[^:]+:0>>>\nq=\[\]\n$/, `${what}: set -e kept the shell after a body of comments`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cut finds a Run’s marks where the live session finds them, whatever string a banner or the body left open: a lone C1 string introducer, an OSC never closed', async () => {
  // An independent read of the fix for the house's read of the 33 commits (#22, comment 6307351104): the stripped text opens a
  // string at U+0090, U+0098 and U+009D–U+009F as the emulator does, and CP1252 text read as Latin-1 holds them (`ž` is U+009E,
  // `Ÿ` U+009F, `˜` U+0098). The session found the marks in the raw output and ended the Run by them; the cut, reading the
  // stripped text, did not see them, kept every line with the plumbing, and showed `Welcome Ko`.
  const marker = { strategy: 'marker' as const, nonce: N };
  const inline = { strategy: 'inline' as const, nonce: N };
  const mark = `<<<START:${N}:4242>>>\r\n`;
  const end = `<<<EXIT:${N}:0>>>\r\n`;
  for (const banner of ['Welcome Ko\u009eel\r\n', 'MOTD \u009fx\r\n', 'Welcome \x1b]0;never closed\r\n']) {
    const what = JSON.stringify(banner);
    assert.equal(cutPlumbing(`${typed(N)}${banner}$ ${typed(N)}${mark}body\r\n${end}$ `, marker), 'body\r\n', `marker: ${what}`);
    assert.equal(cutPlumbing(`typed\r\n${banner}${mark}body\r\n${end}remote$ `, inline), 'body\r\n', `inline: ${what}`);
  }
  // A string the body opened with no ESC after it: the end mark is still the end, and none of it stays in the raw cut, which
  // shows as the emulator shows it.
  const opened = cutPlumbing(`${typed(N)}${mark}Ko\u009eel\r\nmore\r\n${end}$ `, marker);
  assert.equal(opened, 'Ko\u009eel\r\nmore\r\n');
  assert.equal(await transcript([{ data: opened, stream: 'pty' }]), 'Ko');
  assert.equal(cutPlumbing(`typed\r\n${mark}out \x1b]0;title\r\n${end}`, inline), 'out \x1b]0;title\r\n', 'an OSC the body left open');
  // Under such a string, a probe's echo is still struck on its own line, the output before it kept, and the accepted answer ends it.
  const probe = `^C\r\n$${inlineProbe(N, false)}\r\n<<<PROBE:${N}:4242:${N}>>>\r\nremote$ `;
  assert.equal(cutPlumbing(`typed\r\n${mark}out\u009e left open\r\n${probe}`, inline), 'out\u009e left open\r\n^C\r\n');
});

test('the cut reads a long line of probe-shaped fragments in time linear in it, with no nonce recorded (a journal from before one was)', () => {
  // An independent read of the fix for the house's read of the 33 commits (#22, comment 6307351104): every probe-echo match scanned
  // to its line's ends, so 100,000 fragments on one line held the event loop for 37 s.
  const n = 'a1b2c3d4';
  const echo = sourceLine('/tmp/x/tsm-cmd-3', 'posix', n);
  for (const fragment of ['<<<PRO""BE:zz ', "<<<PRO''BE:zz ", '<<<PROBE:zz:1:yy>>> ']) {
    const raw = `${echo}\r\n<<<START:${n}:42>>>\r\nout ${fragment.repeat(100_000)}\r\nafter\r\n<<<EXIT:${n}:0>>>\r\n`;
    for (const of of [{ strategy: 'marker' as const }, {}]) {
      const t = performance.now();
      const cut = cutPlumbing(raw, of);
      const ms = performance.now() - t;
      assert.equal(cut, 'after\r\n', `${fragment}: the line of fragments is struck`);
      // Tens of seconds on the old pass; about 150 ms now, and the bound leaves room for a loaded machine.
      assert.ok(ms < 2000, `${fragment} ${JSON.stringify(of)}: ${Math.round(ms)} ms`);
    }
  }
});

test('an escape before a struck probe echo stays with the output: a colour, a title, a link’s start set what follows as before', async () => {
  // An independent read of the fix: ending every kept piece right after the line end before a struck line dropped them.
  const marker = { strategy: 'marker' as const, nonce: N };
  for (const esc of ['\x1b[31m', '\x1b]0;title\x07', '\x1b]8;;http://x\x07']) {
    const raw = `${typed(N)}<<<START:${N}:4242>>>\r\nout\r\n${esc}$${markerProbe(N)}\r\nmore\r\n<<<EXIT:${N}:0>>>\r\n`;
    assert.equal(cutPlumbing(raw, marker), `out\r\n${esc}more\r\n`, JSON.stringify(esc));
  }
});

test('with no nonce recorded, a program’s own split mark word inside a title or a DCS splits nothing: the payload stays hidden', async () => {
  // An independent read of the fix: `<<<PRO''BE:` inside a title split it, the line was struck as a probe's echo, and the
  // title's payload showed (`out1\nsecretafter`).
  const n = 'a1b2c3d4';
  const head = `${sourceLine('/tmp/x/tsm-cmd-3', 'posix', n)}\r\n<<<START:${n}:42>>>\r\n`;
  const bodies = [
    `out1\r\n\x1b]0;t <<<PRO''BE:zz:%s:%s>>>\\n' "$$"\nsecret\x07after\r\n`,
    `out1\r\n\x1b]0;t <<<PRO""BE:zz secret\x07after\r\n`,
    `out1\r\n\x1bPq ${markerProbe('ffffffff')}\nsecret\x1b\\after\r\n`,
  ];
  for (const body of bodies) {
    for (const of of [{ strategy: 'marker' as const }, { strategy: 'marker' as const, nonce: n }]) {
      const shown = await transcript([{ data: cutPlumbing(`${head}${body}<<<EXIT:${n}:0>>>\r\n`, of), stream: 'pty' }]);
      assert.equal(shown, 'out1\nafter', `${JSON.stringify(of)}: ${JSON.stringify(body)}`);
    }
  }
});

test('keptRanges are the raw slices the cut keeps, in order and none empty: a reader can report where in the journal a Run’s output is', () => {
  // For the reader's Run read, which reports journal positions (a request from the round fixing it).
  const marker = { strategy: 'marker' as const, nonce: N };
  const cases: Array<[string, Parameters<typeof cutPlumbing>[1]]> = [
    [`${typed(N)}<<<START:${N}:4242>>>\r\nout\r\n<<<EXIT:${N}:0>>>\r\n$ `, marker],
    [`${typed(N)}<<<START:${N}:4242>>>\r\nA\r\n\x1b[31m$${markerProbe(N)}\r\nB\r\n<<<PROBE:${N}>>>\r\n$ `, marker],
    [`typed\r\n<<<START:${N}:4242>>>\r\nhello\r\n<<<EXIT:${N}:0>>>\r\nremote$ `, { strategy: 'inline', nonce: N }],
    [`echo hi\r\nhi\r\n`, { strategy: 'basic' }],
    [`hi\r\n`, { strategy: 'rich' }],
    [`${typed(N)}`, marker],
  ];
  for (const [raw, of] of cases) {
    const ranges = keptRanges(raw, of);
    assert.equal(ranges.map(([s, e]) => raw.slice(s, e)).join(''), cutPlumbing(raw, of), JSON.stringify(raw));
    ranges.forEach(([s, e], i) => assert.ok(s < e && (i === 0 || ranges[i - 1]![1] <= s), `in order, none empty: ${JSON.stringify(ranges)}`));
  }
  const [first] = keptRanges(cases[0]![0], marker);
  assert.deepEqual(first, [cases[0]![0].indexOf('out'), cases[0]![0].indexOf('<<<EXIT')], 'the output’s own place in the raw');
  assert.deepEqual(keptRanges(cases[1]![0], marker).map(([s, e]) => cases[1]![0].slice(s, e)), ['A\r\n\x1b[31m', 'B\r\n'], 'a struck probe echo splits the output in two');
  assert.deepEqual(keptRanges(cases[5]![0], marker), [], 'nothing kept, no range');
});

test('a page or tail of a declared shell’s Run that begins with a blank line keeps it: only a whole read begins with the start mark’s line end', async () => {
  // A request from the round fixing the reader's Run read: the inline strategy's rule that drops the line end the output begins
  // with (its start mark's, journaled before the Run's output) dropped a window's own blank line too, in a page, a tail and
  // journalRunText's tail windows.
  const inline = { strategy: 'inline' as const, nonce: N };
  const raw = `\r\n\r\nline\r\n<<<EXIT:${N}:0>>>\r\nremote$ `;
  assert.equal(cutPlumbing(raw, inline), '\r\nline\r\n', 'a whole read: the start mark’s line end goes');
  assert.equal(cutPlumbing(raw, { ...inline, truncated: true }), '\r\n\r\nline\r\n', 'a window: its blank line stays');
  const run = { runId: 'r1', target: 'shell', strategy: 'inline', nonce: N } as unknown as RunInfo;
  const window = (truncated: boolean) => ({ events: [{ type: 'output', seq: 5, ts: 0, stream: 'pty', data: raw, runId: 'r1' }], from: 5, to: 5, truncated }) as unknown as RunOutput;
  assert.equal((await journalRunText(window(false), { cols: 80, rows: 24 }, run)).text, '\nline');
  assert.equal((await journalRunText(window(true), { cols: 80, rows: 24 }, run)).text, '\n\nline', 'a tail window');
});
