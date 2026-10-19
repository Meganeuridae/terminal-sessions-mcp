/** One grammar for the marks a Run prints and the readers cut around (core/plumbing.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutPlumbing, exitMark, nonceOf, probeMark, startMark } from '../src/core/plumbing.js';
import { inlineLines, inlineProbe } from '../src/core/session.js';

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

test('a reviewer’s read (6270045466): nonceOf names the nonce a printed mark carries, and nothing for text that is no mark', () => {
  assert.equal(nonceOf('<<<EXIT:74ef5182:0>>>'), '74ef5182');
  assert.equal(nonceOf('<<<PROBE:74ef5182>>>'), '74ef5182');
  assert.equal(nonceOf('<<<PROBE:74ef5182:4242:74ef5182>>>'), '74ef5182');
  assert.equal(nonceOf('<<<START:74ef5182:4242>>>'), '74ef5182');
  assert.equal(nonceOf(`echo "<<<EXI""T:74ef5182:$?>>>"`), undefined, 'the typed echo is split so it is no mark');
  assert.equal(nonceOf('plain output'), undefined);
  assert.equal(nonceOf(`. '/tmp/x/tsm-cmd-1'`), undefined);
});
