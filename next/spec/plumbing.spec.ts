/** One grammar for the marks a Run prints and the readers cut around (core/plumbing.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutPlumbing, exitMark, probeMark, startMark } from '../src/core/plumbing.js';
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
  assert.equal(cutPlumbing(echoShaped), 'line2\nline3\n', 'by shape alone (no nonce recorded) it is taken for the echo, and line1 is lost');
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
  // The same pid in another PID namespace, still no token: struck too.
  assert.equal(cutPlumbing(`\r\nA\r\n$ ${echo}\r\n<<<PROBE:${N}:1000:>>>\r\nB\r\n`, inline), 'A\r\nB\r\n');
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
