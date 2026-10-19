/**
 * The GUI end to end in a headless browser against a real daemon endpoint and
 * real bash: the page loads under its CSP, attaches with a snapshot (G13), an
 * observer cannot type (G17), the seat holder's keystrokes reach the shell, and
 * a terminal query printed by a program gets exactly one reply — the daemon's
 * (G25). Skipped when no browser can be launched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import type { JournalEvent } from '../src/core/types.js';
import { TermServer, type LogRecord } from '../src/transport/server.js';

/** The slice of puppeteer this test uses (loaded dynamically so a machine without it skips). */
interface Page {
  goto(url: string, o?: { waitUntil?: string }): Promise<unknown>;
  on(ev: 'pageerror', cb: (e: Error) => void): void;
  on(ev: 'console', cb: (m: { type(): string; text(): string }) => void): void;
  evaluate<T>(expr: string): Promise<T>;
  waitForFunction(expr: string, o?: { timeout?: number; polling?: number }): Promise<unknown>;
  click(selector: string): Promise<void>;
  keyboard: { type(text: string, o?: { delay?: number }): Promise<void>; press(key: string): Promise<void> };
  setViewport(v: { width: number; height: number }): Promise<void>;
  select(selector: string, ...values: string[]): Promise<string[]>;
  close(): Promise<void>;
}
interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-gui-'));
let registry: SessionRegistry;
let server: TermServer;
let port = 0;
let browser: Browser | undefined;
let skip: string | false = false;
const logs: LogRecord[] = [];

before(async () => {
  // Real bash with no user rc and no history file of the user's (HOME and HISTFILE point into the temp dir).
  registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true, daemonEnv: { ...process.env, HOME: dataDir, HISTFILE: path.join(dataDir, 'bash_history') } });
  server = new TermServer({ app: new App({ registry, defaultWaitMs: 5000 }), resolver: new TokenMapResolver({ tokens: { tg: 'agent:g@test' } }), host: '127.0.0.1', port: 0, logger: (r) => logs.push(r) });
  port = (await server.listen()).port;
  try {
    const mod = (await import('puppeteer' as string)) as { default: { launch(o: Record<string, unknown>): Promise<Browser> } };
    browser = await mod.default.launch({ headless: true });
  } catch (e) {
    skip = `no headless browser: ${(e as Error).message.split('\n')[0]}`;
  }
});

after(async () => {
  await browser?.close();
  await server.close();
  await registry.closeAll();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function agent(): Promise<{ call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=tg&profile=full`);
  await new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  let id = 0;
  const pending = new Map<number, (r: { structuredContent: Record<string, unknown> }) => void>();
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as { id?: number; result?: { structuredContent: Record<string, unknown> } };
    if (m.id !== undefined && m.result) pending.get(m.id)?.(m.result);
  });
  return {
    call: (name, args) =>
      new Promise((resolve) => {
        const n = ++id;
        pending.set(n, (r) => resolve(r.structuredContent));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }));
      }),
    close: () => ws.close(),
  };
}

const HUMAN = 'human:gui:agent:g@test';
const rows = `(document.querySelector('.xterm-rows')?.innerText ?? '')`;

test('GUI: snapshot on attach, observers cannot type, the seat holder types, and a DSR query gets exactly one reply (G13, G17, G25)', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const a = await agent();
  const opened = await a.call('session_open', { session: 'guit', visibility: 'shared' });
  assert.equal(opened.role, 'controller');
  const ran = await a.call('run', { session: 'guit', command: 'echo SNAPSHOT-MARK-$((40+2))' });
  assert.equal(ran.state, 'exited');
  const s = registry.get('guit');
  assert.ok(s && s.kind === 'live');
  const journal = s.session.journal;
  const humanInput = () => journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'input' }> => e.type === 'input' && e.principal === HUMAN);

  const page = await browser.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy|Refused to/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/?token=tg`, { waitUntil: 'load' });
  assert.equal(await page.evaluate<string>('location.search'), '', 'the token is taken out of the address bar');
  await page.waitForFunction(`document.getElementById('conn-text')?.textContent === 'connected'`, { timeout: 10_000 });
  await page.waitForFunction(`[...document.querySelectorAll('.session .name')].some((e) => e.textContent === 'guit')`, { timeout: 10_000 });
  await page.evaluate(`[...document.querySelectorAll('.session')].find((e) => e.querySelector('.name').textContent === 'guit').click()`);

  // G13: the snapshot shows what the terminal showed before the GUI attached.
  await page.waitForFunction(`${rows}.includes('SNAPSHOT-MARK-42')`, { timeout: 10_000 });
  assert.match(await page.evaluate<string>(`document.getElementById('node').textContent`), /human:gui:agent:g@test/);
  assert.equal(await page.evaluate<string>(`document.getElementById('seat').textContent`), 'seat: agent:g@test');

  // G17: an observer's keystrokes go nowhere.
  await page.click('#term');
  await page.keyboard.type('echo NOPE');
  await page.keyboard.press('Enter');
  await page.waitForFunction(`document.getElementById('notice').textContent.includes('observing')`, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(humanInput(), [], 'nothing typed by an observer reached the terminal');

  // Live events after the snapshot: output the agent produces shows up.
  await a.call('run', { session: 'guit', command: 'echo LIVE-$((1+1))' });
  await page.waitForFunction(`${rows}.includes('LIVE-2')`, { timeout: 5000 });

  // The agent releases the seat; the human takes it and types.
  await a.call('control', { session: 'guit', action: 'release' });
  await page.waitForFunction(`document.getElementById('seat').textContent === 'seat free'`, { timeout: 5000 });
  await page.click('#seat-btn');
  await page.waitForFunction(`document.getElementById('seat').textContent === 'you hold the seat'`, { timeout: 5000 });
  assert.equal(s.session.currentController, HUMAN);
  await page.click('#term');
  await page.keyboard.type('echo TYPED-$((6*7))');
  await page.keyboard.press('Enter');
  await page.waitForFunction(`${rows}.includes('TYPED-42')`, { timeout: 8000 });
  assert.ok(humanInput().length > 0, 'the seat holder typed');
  const typedRun = s.session.listRuns().find((r) => r.line === 'echo TYPED-$((6*7))');
  assert.ok(typedRun, 'the typed line became a Run');
  assert.equal(typedRun.origin, 'human');

  // G25: a program asks for the cursor position; only the daemon's emulator answers.
  const before = journal.lastSeq;
  await page.keyboard.type(`printf '\\033[6n'; sleep 0.5; echo DSR-$((3*3))`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(`${rows}.includes('DSR-9')`, { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 300));
  const after = journal.since(before).events;
  const replies = after.filter((e) => e.type === 'input' && e.kind === 'protocol-reply');
  assert.equal(replies.length, 1, `one reply to one query: ${JSON.stringify(replies)}`);
  const cpr = /\x1b\[\d+;\d+R/;
  assert.ok(replies[0]!.type === 'input' && cpr.test(replies[0]!.data), 'the reply is a cursor position report');
  const echoedByGui = after.filter((e) => e.type === 'input' && e.principal === HUMAN && cpr.test(e.data));
  assert.deepEqual(echoedByGui, [], "the GUI's emulator did not answer");

  assert.deepEqual(problems, [], 'no page errors and no CSP violations');
  a.close();
});

// ───────────────────────────── outages, secrets, new lives, sizing, process output ─────────────────────────────

/** A byte-transparent TCP forwarder that can drop every connection and refuse new ones (a network outage). */
async function outageProxy(to: number): Promise<{ port: number; drop(): void; resume(): void; close(): Promise<void> }> {
  const socks = new Set<net.Socket>();
  let down = false;
  const srv = net.createServer((client) => {
    if (down) return client.destroy();
    const upstream = net.connect(to, '127.0.0.1');
    for (const s of [client, upstream]) {
      socks.add(s);
      s.on('error', () => undefined);
      s.on('close', () => socks.delete(s));
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return {
    port: (srv.address() as net.AddressInfo).port,
    drop() {
      down = true;
      for (const s of socks) s.destroy();
    },
    resume() {
      down = false;
    },
    close: () => new Promise<void>((r) => {
      for (const s of socks) s.destroy();
      srv.close(() => r());
    }),
  };
}

async function openGui(url: string, problems: string[]): Promise<Page> {
  const page = await browser!.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION|Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(`document.getElementById('conn-text')?.textContent === 'connected'`, { timeout: 10_000 });
  return page;
}

async function pick(page: Page, name: string): Promise<void> {
  await page.waitForFunction(`[...document.querySelectorAll('.session .name')].some((e) => e.textContent === ${JSON.stringify(name)})`, { timeout: 10_000 });
  await page.evaluate(`[...document.querySelectorAll('.session')].find((e) => e.querySelector('.name').textContent === ${JSON.stringify(name)}).click()`);
}

/** The agent releases the seat and the GUI human takes it. */
async function takeSeat(page: Page, a: { call(n: string, x: Record<string, unknown>): Promise<Record<string, unknown>> }, session: string): Promise<void> {
  await a.call('control', { session, action: 'release' });
  await page.waitForFunction(`document.getElementById('seat').textContent === 'seat free'`, { timeout: 5000 });
  await page.click('#seat-btn');
  await page.waitForFunction(`document.getElementById('seat').textContent === 'you hold the seat'`, { timeout: 5000 });
}

const inputsOf = (session: string) => {
  const s = registry.get(session);
  assert.ok(s && s.kind === 'live');
  return s.session.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'input' }> => e.type === 'input' && e.principal === HUMAN);
};

test('tsg-7: keystrokes typed while the connection is down are dropped with a notice, never sent after the reconnect', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const a = await agent();
  await a.call('session_open', { session: 'outage', visibility: 'shared' });
  const proxy = await outageProxy(port);
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${proxy.port}/?token=tg`, problems);
  try {
    await pick(page, 'outage');
    await page.waitForFunction(`${rows}.includes('$')`, { timeout: 10_000 });
    await takeSeat(page, a, 'outage');
    proxy.drop();
    await page.waitForFunction(`document.getElementById('conn-text').textContent === 'reconnecting'`, { timeout: 5000 });
    await page.click('#term');
    await page.keyboard.type('echo QUEUED-$((2+3))');
    await page.keyboard.press('Enter');
    await page.waitForFunction(`document.getElementById('notice').textContent.includes('Not connected')`, { timeout: 5000 });
    proxy.resume();
    await page.waitForFunction(`document.getElementById('conn-text').textContent === 'connected'`, { timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(inputsOf('outage').filter((e) => e.data.includes('QUEUED')), [], 'nothing typed during the outage reached the terminal');
    assert.ok(!(await page.evaluate<string>(rows)).includes('QUEUED-5'));
  } finally {
    await page.close();
    await proxy.close();
    a.close();
  }
});

test('tsg-8 (G26): input at a password prompt is sent as sensitive automatically, and the lock makes any input sensitive', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const a = await agent();
  await a.call('session_open', { session: 'secret', visibility: 'shared' });
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${port}/?token=tg`, problems);
  try {
    await pick(page, 'secret');
    await takeSeat(page, a, 'secret');
    await page.click('#term');
    // The prompt text is built at run time, so the echoed command line never contains it: waiting for it waits for the prompt.
    await page.keyboard.type(`P=word; read -s -p "Pass$P: " PW; echo; echo "len=\${#PW}"`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(`${rows}.includes('Password:')`, { timeout: 8000 });
    await page.keyboard.type('hunter2-s3cret');
    // Secret mode turns on at the first keystroke on a password line (the session also redacts input at a password prompt on its own, m2-2).
    await page.waitForFunction(`document.getElementById('secret').textContent === 'Secret: auto'`, { timeout: 3000 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(`${rows}.includes('len=14')`, { timeout: 8000 });
    await page.waitForFunction(`document.getElementById('secret').textContent === 'Secret: off'`, { timeout: 3000 }); // auto ends with the line
    const secretInputs = inputsOf('secret').filter((e) => e.sensitive);
    assert.ok(secretInputs.length > 0, 'the password was sent as sensitive input');
    // The lock: anything typed while it is on is sensitive.
    await page.click('#secret');
    assert.equal(await page.evaluate<string>(`document.getElementById('secret').textContent`), 'Secret: on');
    await page.click('#term');
    await page.keyboard.type('# locked-text');
    await new Promise((r) => setTimeout(r, 300));
    await page.click('#secret');
    await page.click('#term');
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 300));
    const journal = fs.readFileSync(path.join(dataDir, 'sessions', 'secret', 'journal.jsonl'), 'utf8');
    assert.ok(!journal.includes('hunter2'), 'the password is not in the journal (read -s does not echo it)');
    // The shell echoes what is typed at its prompt (G26 makes no promise about output); the input events are redacted.
    assert.deepEqual(inputsOf('secret').filter((e) => e.data.includes('locked') || e.data.includes('hunter2')), [], 'no input event carries the text');
    assert.ok(inputsOf('secret').filter((e) => e.sensitive).length > secretInputs.length, 'the locked input was sensitive');
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    a.close();
  }
});

test('tsg-9: after the session is closed the GUI shows its history, and follows it into a new life', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const a = await agent();
  await a.call('session_open', { session: 'lives', visibility: 'shared' });
  await a.call('run', { session: 'lives', command: 'echo FIRST-$((20+1))' });
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${port}/?token=tg`, problems);
  try {
    await pick(page, 'lives');
    await page.waitForFunction(`${rows}.includes('FIRST-21')`, { timeout: 10_000 });
    await a.call('session_close', { session: 'lives' });
    await page.waitForFunction(`document.getElementById('notice').textContent.includes('closed')`, { timeout: 8000 });
    await page.waitForFunction(`${rows}.includes('FIRST-21')`, { timeout: 8000 }); // the history view
    const again = await a.call('run', { session: 'lives', command: 'echo SECOND-$((40+2))' });
    assert.equal(again.state, 'exited');
    await page.waitForFunction(`${rows}.includes('SECOND-42')`, { timeout: 10_000 });
    await page.waitForFunction(`!document.getElementById('seat-btn').disabled && !document.getElementById('notice').textContent.includes('closed')`, { timeout: 5000 });
    // The shell exits; a click on the (current) session after its new life reattaches too.
    await a.call('run', { session: 'lives', command: 'exit 0', wait: 2000 });
    await page.waitForFunction(`document.getElementById('notice').textContent.includes('exited')`, { timeout: 8000 });
    await a.call('run', { session: 'lives', command: 'echo THIRD-$((60+3))' });
    await pick(page, 'lives');
    await page.waitForFunction(`${rows}.includes('THIRD-63')`, { timeout: 10_000 });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    a.close();
  }
});

test('tsg-11: the controller fits rows as well as columns to the window', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const a = await agent();
  await a.call('session_open', { session: 'fit', visibility: 'shared' });
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${port}/?token=tg`, problems);
  const size = () => {
    const s = registry.get('fit');
    assert.ok(s && s.kind === 'live');
    return { cols: s.session.screen.cols, rows: s.session.screen.rows };
  };
  try {
    await page.setViewport({ width: 1100, height: 500 });
    await pick(page, 'fit');
    await takeSeat(page, a, 'fit');
    await new Promise((r) => setTimeout(r, 600));
    const short = size();
    await page.setViewport({ width: 1100, height: 1000 });
    const end = Date.now() + 5000;
    while (size().rows <= short.rows && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    const tall = size();
    assert.ok(tall.rows > short.rows + 10, `rows follow the window height: ${JSON.stringify(short)} → ${JSON.stringify(tall)}`);
  } finally {
    await page.close();
    a.close();
  }
});

test('tsg-22/tsg-23/mcpl-14/tsg-16: open private or shared; a process Run shows its output; notes show; the list is pushed, not polled', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const a = await agent();
  await a.call('session_open', { session: 'procs', visibility: 'shared' });
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${port}/?token=tg`, problems);
  try {
    // tsg-22: the Open form offers private (the default) and shared.
    assert.equal(await page.evaluate<string>(`document.getElementById('new-vis').value`), 'private');
    await page.evaluate(`document.getElementById('new-name').value = 'mine-private'`);
    await page.click('#new-form button[type=submit]');
    await page.waitForFunction(`document.getElementById('title').textContent === 'mine-private'`, { timeout: 8000 });
    const priv = registry.get('mine-private');
    assert.ok(priv && priv.kind === 'live');
    assert.equal(priv.session.visibility, 'private');
    await page.select('#new-vis', 'shared');
    await page.evaluate(`document.getElementById('new-name').value = 'mine-shared'`);
    await page.click('#new-form button[type=submit]');
    await page.waitForFunction(`document.getElementById('title').textContent === 'mine-shared'`, { timeout: 8000 });
    const shared = registry.get('mine-shared');
    assert.ok(shared && shared.kind === 'live' && shared.session.visibility === 'shared');

    // tsg-23: a process Run's stdout and stderr, in the Run's own pane — read on demand for a Run from before the attach.
    const early = await a.call('run', { session: 'procs', target: 'process', command: `printf 'EARLY-%s\\n' 7` });
    assert.equal(early.state, 'exited');
    await pick(page, 'procs');
    await page.waitForFunction(`document.querySelectorAll('.run-out summary').length > 0`, { timeout: 8000 });
    await page.evaluate(`document.querySelector('.run-out summary').click()`);
    await page.waitForFunction(`[...document.querySelectorAll('.run-out pre')].some((p) => p.textContent.includes('EARLY-7'))`, { timeout: 8000 });
    await page.waitForFunction(`document.getElementById('title').textContent === 'procs'`, { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 300));
    // It prints after a second, so its output streams to the attached page rather than predating the attach.
    const ran = await a.call('run', { session: 'procs', target: 'process', command: `sleep 1; printf 'OUT-%s\\n' 1; printf 'ERR-%s\\n' 2 >&2` });
    assert.equal(ran.state, 'exited');
    await page.waitForFunction(`[...document.querySelectorAll('.run-out pre')].some((p) => p.textContent.includes('OUT-1') && p.textContent.includes('ERR-2'))`, { timeout: 8000 });
    assert.ok(await page.evaluate<boolean>(`[...document.querySelectorAll('.run-out .stderr')].some((e) => e.textContent.includes('ERR-2'))`), 'stderr is marked apart');
    assert.ok(!(await page.evaluate<string>(rows)).includes('OUT-1'), 'never drawn into the shell screen');

    // mcpl-14: a note on the session's channel is shown to the human.
    const s = registry.get('procs');
    assert.ok(s && s.kind === 'live');
    s.session.journal.append({ type: 'note', text: 'please do not deploy yet', principal: 'agent:g@test', channel: 'terminal:procs' });
    await page.waitForFunction(`document.getElementById('activity').textContent.includes('please do not deploy yet')`, { timeout: 5000 });

    // tsg-16: a session another client opens appears without a poll, and the GUI never lists through tools/call.
    await a.call('session_open', { session: 'pushed-in', visibility: 'shared' });
    await page.waitForFunction(`[...document.querySelectorAll('.session .name')].some((e) => e.textContent === 'pushed-in')`, { timeout: 3000 });
    assert.equal(logs.filter((l) => l.msg === 'tool call' && l.tool === 'session_list').length, 0, 'no session_list polling');
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    a.close();
  }
});
