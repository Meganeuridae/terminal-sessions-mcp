/** One grammar for the marks a Run prints and the readers cut around (core/plumbing.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutPlumbing, exitMark, firstMark, probeMark, startMark } from '../src/core/plumbing.js';
import { inlineLines } from '../src/core/session.js';

/** What the shell prints for a typed line: the split words joined. */
const printed = (typed: string) => typed.replace(/""|''/g, '');

test('the marks the session prints are the marks the grammar parses: start with the pid, exit with a status, probe with or without a pid', () => {
  const last = inlineLines('echo hi', 'n0ff', false).at(-1)!;
  assert.match(last, /STAR''T:n0ff:%s>>>/, 'the typed start marker is split');
  assert.match(printed(last).replace('%s', '4242'), startMark('n0ff'));
  assert.equal(startMark('n0ff').exec('<<<START:n0ff:4242>>>')![1], '4242');
  assert.equal(exitMark('n0ff').exec('x\n<<<EXIT:n0ff:-1>>>\n')![1], '-1');
  assert.equal(probeMark('n0ff').exec('<<<PROBE:n0ff>>>')![1], undefined, 'the marker strategy names no pid');
  assert.equal(probeMark('n0ff').exec('<<<PROBE:n0ff:77>>>')![1], '77', 'the inline strategy names the shell');
  assert.equal(startMark().test('<<<START:n0ff>>>'), false, 'the old shape, without a pid, is no start marker');
  assert.equal(firstMark('a<<<PROBE:n0ff:1>>>b<<<EXIT:n0ff:0>>>', 'n0ff'), 1);
  assert.equal(firstMark('nothing', 'n0ff'), -1);
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
  assert.equal(cutPlumbing(probedInline), 'OUT\n');
  const coloured = '\x1b[31mA\x1b[0m\n<<<EXIT:74ef5182:0>>>\n';
  assert.equal(cutPlumbing(coloured), '\x1b[31mA\x1b[0m\n', 'the cut is made in the raw text, escapes kept');
  assert.equal(cutPlumbing('line one\nline two\n'), 'line one\nline two\n', 'nothing to cut');
});
