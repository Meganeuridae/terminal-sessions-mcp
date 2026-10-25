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
import type { PtyHandle } from '../src/backends/types.js';
import type { JournalEvent } from '../src/core/types.js';
import { TermServer, type LogRecord } from '../src/transport/server.js';
import { gate, until } from './testhost.js';

/** The slice of puppeteer this test uses (loaded dynamically so a machine without it skips). */
interface Page {
  goto(url: string, o?: { waitUntil?: string }): Promise<unknown>;
  on(ev: 'pageerror', cb: (e: Error) => void): void;
  on(ev: 'console', cb: (m: { type(): string; text(): string }) => void): void;
  evaluate<T>(expr: string): Promise<T>;
  waitForFunction(expr: string, o?: { timeout?: number; polling?: number }): Promise<unknown>;
  click(selector: string): Promise<void>;
  keyboard: { type(text: string, o?: { delay?: number }): Promise<void>; press(key: string): Promise<void>; down(key: string): Promise<void>; up(key: string): Promise<void> };
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
    // GitHub's Ubuntu runners restrict unprivileged user namespaces, which Chrome's sandbox needs: under CI the
    // browser runs without it (the page is the daemon's own GUI, loaded from the loopback address).
    browser = await mod.default.launch({ headless: true, args: process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [] });
  } catch (e) {
    skip = `no headless browser: ${(e as Error).message.split('\n')[0]}`;
    // A machine without a browser skips; CI must not pass with the page never run (the house's read of 2f357bd, #22).
    if (process.env.GUI_REQUIRED === '1') throw new Error(`GUI_REQUIRED=1 but ${skip}`);
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
const info = `document.getElementById('info').textContent`;
const noticeText = `document.getElementById('notice').textContent`;
/** A paste into the terminal, as the browser delivers one (xterm reads the event's clipboard data). */
const paste = (text: string) =>
  `(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)}); document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`;
const clickSession = (name: string) => `[...document.querySelectorAll('.session')].find((e) => e.querySelector('.name').textContent === ${JSON.stringify(name)}).click()`;

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

  // The other query kinds the page swallows: DA1, a colour query (OSC 11) and DECRQSS. Each gets the daemon's one
  // reply and nothing from the page; its xterm would answer all three on its own.
  const before2 = journal.lastSeq;
  // The CPR reply above landed in the tty's input after its command ended; readline holds its tail: clear the line first.
  await page.keyboard.down('Control');
  await page.keyboard.press('u');
  await page.keyboard.up('Control');
  await page.keyboard.type(`printf '\\033[c\\033]11;?\\033\\\\\\033P$qm\\033\\\\'; sleep 0.5; echo QRY-$((2*2))`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(`${rows}.includes('QRY-4')`, { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 300));
  const after2 = journal.since(before2).events.filter((e): e is Extract<JournalEvent, { type: 'input' }> => e.type === 'input');
  const daemonReplies = after2.filter((e) => e.kind === 'protocol-reply').map((e) => e.data);
  assert.equal(daemonReplies.filter((d) => /^\x1b\[\?\d+(;\d+)*c$/.test(d)).length, 1, `one DA1 reply: ${JSON.stringify(daemonReplies)}`);
  assert.equal(daemonReplies.filter((d) => d.startsWith('\x1bP1$r')).length, 1, `one DECRQSS reply: ${JSON.stringify(daemonReplies)}`);
  assert.ok(daemonReplies.length <= 3, `nothing else (the daemon's emulator answers no colour query today): ${JSON.stringify(daemonReplies)}`);
  const looksLikeReply = (d: string) => /\x1b\[\?\d/.test(d) || d.includes('\x1b]11;') || d.includes('\x1bP');
  assert.deepEqual(after2.filter((e) => e.principal === HUMAN && looksLikeReply(e.data)), [], "the GUI's emulator answered none of them");

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
    const typedBefore = inputsOf('outage').length;
    proxy.drop();
    await page.waitForFunction(`document.getElementById('conn-text').textContent === 'reconnecting'`, { timeout: 5000 });
    await page.click('#term');
    await page.keyboard.type('echo QUEUED-$((2+3))');
    await page.keyboard.press('Enter');
    await page.waitForFunction(`document.getElementById('notice').textContent.includes('Not connected')`, { timeout: 5000 });
    // Output produced during the outage: shown after the reconnect only by the reattach's fresh snapshot.
    await a.call('run', { session: 'outage', command: 'echo DURING-$((5+5))' });
    proxy.resume();
    await page.waitForFunction(`document.getElementById('conn-text').textContent === 'connected'`, { timeout: 15_000 });
    await page.waitForFunction(`${rows}.includes('DURING-10')`, { timeout: 10_000 });
    // A key typed now, on the connection the queue would have used, arrives after anything queued: waited for in
    // place of a sleep, it shows the queue had its chance to arrive and nothing came. The seat is taken again first,
    // since a client that held its queue until it had the seat back would send it then.
    await takeSeat(page, a, 'outage');
    await page.click('#term');
    await page.keyboard.type('~');
    await until(() => inputsOf('outage').some((e) => e.data.includes('~')), 5000, 'a key typed after the reconnect reached the terminal');
    assert.equal(inputsOf('outage').slice(typedBefore).map((e) => e.data).join(''), '~', 'nothing typed during the outage reached the terminal, whole or in part');
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
    // Nor does the line hold `pass` while it is typed: the GUI took `…"Pass$P: ` at the cursor for a password prompt and sent
    // the rest of the command as sensitive (a reviewer's read of the fixes for #22).
    // The prompt is printed over a row that holds other text, which stays to the cursor's right: the GUI reads the prompt left
    // of the cursor, as the daemon does. Read whole, the row did not read as one. readline's redraw for the seat's resize can
    // leave the end of the command's echo there, by run on the VPS, and the same wait failed once on Ubuntu CI (a reviewer's
    // read of the fixes for #22).
    await page.keyboard.type(`A=Pa; P=word; printf '%s\\r' "stale text after the prompt"; read -s -p "\${A}ss$P: " PW; echo; echo "len=\${#PW}"`);
    await page.keyboard.press('Enter');
    const live = registry.get('secret');
    assert.ok(live && live.kind === 'live');
    // A wait below that fails says what the screen and the journal held: twice on macOS CI the prompt never showed, and the
    // log held nothing to tell why (a reviewer's read of the fixes for #22).
    const held = async (e: Error): Promise<never> => {
      const shown = await page.evaluate<string>(rows).catch((r: Error) => `(the rows could not be read: ${r.message})`);
      // Every kind, with its time from the first: a seat change, a resize or a gap between the prompt and the password shows.
      const events = live.session.journal.since(0).events;
      const t0 = events[0]?.ts ?? 0;
      const last = events
        .slice(-24)
        .map((ev) => {
          const { seq, ts, type, ...rest } = ev;
          return `${seq} +${ts - t0}ms ${type} ${JSON.stringify(rest).slice(0, 200)}`;
        })
        .join(' | ');
      // Once on Ubuntu CI the password was typed and secret mode never turned on: the page's seat, label, notice, focus and
      // cursor row say whether the keys were dropped or the cursor's line didn't read as a prompt (a reviewer's read of the
      // fixes for #22).
      const bar = await page
        .evaluate<string>(
          `JSON.stringify({ conn: document.getElementById('conn-text')?.textContent, seat: document.getElementById('seat')?.textContent, secret: document.getElementById('secret')?.textContent, notice: document.getElementById('notice')?.textContent, focus: document.activeElement?.className, cursorRow: document.querySelector('.xterm-rows .xterm-cursor')?.parentElement?.innerText })`,
        )
        .catch((r: Error) => `(the page could not be read: ${r.message})`);
      throw new Error(`${e.message}. The page: ${bar.slice(0, 800)}. Its last problems: ${JSON.stringify(problems.slice(-4).map((x) => x.slice(0, 200)))}. The screen's rows: ${JSON.stringify(shown.slice(-800))}. The journal's last events: ${last}`);
    };
    await page.waitForFunction(`${rows}.includes('Password:')`, { timeout: 8000 }).catch(held);
    assert.deepEqual(inputsOf('secret').filter((ev) => ev.sensitive), [], 'nothing before the prompt was sent as sensitive');
    // On screen is not yet in force: `read -s` prints its prompt and turns echo off after it, with a tcsetattr that waits for
    // the prompt to drain. On Linux that returns at once; on macOS it waits for the daemon to read the prompt (by reading
    // XNU's ttywait; we can't run macOS), so keys typed the moment the prompt shows could be echoed into the journal, as they
    // were once on macOS CI (a reviewer's read of the fixes for #22). The password waits for the mode `read -s` reads in.
    const pty = (live.session as unknown as { pty: PtyHandle }).pty;
    let mode: ReturnType<NonNullable<PtyHandle['inputMode']>>;
    await until(() => {
      mode = pty.inputMode?.();
      return mode !== undefined && mode.canonical && !mode.echo;
    }, 5000, "the terminal in read -s's mode: canonical, echo off").catch((e: Error) => {
      // Which of the two it was: a mode that never came, or one that could not be read here (stty, the pty's name).
      throw new Error(`${e.message}; the last mode read: ${mode === undefined ? 'none (it could not be read)' : JSON.stringify(mode)}`);
    });
    await page.keyboard.type('hunter2-s3cret');
    // Secret mode turns on at the first keystroke on a password line (the session also redacts input at a password prompt on its own, m2-2).
    await page.waitForFunction(`document.getElementById('secret').textContent === 'Secret: auto'`, { timeout: 3000 }).catch(held);
    await page.keyboard.press('Enter');
    await page.waitForFunction(`${rows}.includes('len=14')`, { timeout: 8000 }).catch(held);
    await page.waitForFunction(`document.getElementById('secret').textContent === 'Secret: off'`, { timeout: 3000 }).catch(held); // auto ends with the line
    const secretInputs = inputsOf('secret').filter((e) => e.sensitive);
    assert.ok(secretInputs.length > 0, 'the password was sent as sensitive input');
    // The lock: anything typed while it is on is sensitive.
    await page.click('#secret');
    assert.equal(await page.evaluate<string>(`document.getElementById('secret').textContent`), 'Secret: on');
    const secretHelp = await page.evaluate<string>(`document.getElementById('secret').title`);
    assert.match(secretHelp, /input events.*\[redacted\]/i, 'the lock describes input-event redaction');
    assert.match(secretHelp, /output.*visible/i, 'the lock warns that program output may expose what was typed');
    await page.click('#term');
    await page.keyboard.type('# locked-text');
    // Waits on the journal, not fixed sleeps: a slow delivery failed the sensitive count, and passed the absence checks
    // on input not yet there (a reviewer's read of the fixes for #22).
    // Every key of it has reached the shell once the shell's echo of it shows, so each of its input events (typed keys
    // flush every few ms, so there can be several) is journaled by then, and the next event is the Enter's. The echo is
    // read across rows: where the prompt and the text cross the right margin it wraps, and the rows' text holds a line end
    // inside it (a reviewer's read of the fixes for #22).
    await page.waitForFunction(`${rows}.replace(/\\n/g, '').includes('# locked-text')`, { timeout: 8000 }).catch(held);
    await page.click('#secret');
    await page.click('#term');
    const beforeEnter = inputsOf('secret').length;
    await page.keyboard.press('Enter');
    // The Enter ends the sensitive line, so the session journals it redacted too (secretInput): any new event is it.
    await until(() => inputsOf('secret').length > beforeEnter, 5000, 'the Enter, journaled');
    const journal = fs.readFileSync(path.join(dataDir, 'sessions', 'secret', 'journal.jsonl'), 'utf8');
    assert.ok(!journal.includes('hunter2'), 'the password is not in the journal (read -s does not echo it)');
    // The shell echoes what is typed at its prompt (G26 makes no promise about output); the input events are redacted.
    assert.deepEqual(inputsOf('secret').filter((e) => e.data.includes('locked') || e.data.includes('hunter2')), [], 'no input event carries the text');
    assert.ok(inputsOf('secret').filter((e) => e.sensitive).length > secretInputs.length, 'the locked input was sensitive');
    // Plain and secret text never share one input call: a paste, the lock, and another paste in one task (inside the
    // coalescing window) give a plain event with the first and a redacted one for the second.
    const beforePaste = inputsOf('secret').length;
    await page.evaluate(`${paste('PLAIN-BIT')}; document.getElementById('secret').click(); ${paste('HIDDEN-BIT')}`);
    await until(() => {
      const pasted = inputsOf('secret').slice(beforePaste);
      return pasted.some((e) => e.data.includes('PLAIN-BIT')) && pasted.some((e) => e.sensitive);
    }, 5000, 'both pastes journaled');
    await page.click('#secret');
    const plain = inputsOf('secret').filter((e) => e.data.includes('PLAIN-BIT'));
    assert.equal(plain.length, 1, 'the plain part was sent on its own');
    assert.ok(!plain[0]!.sensitive, 'and not as sensitive');
    assert.deepEqual(inputsOf('secret').filter((e) => e.data.includes('HIDDEN-BIT')), [], 'the locked part is redacted');
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
  const grow = async (dim: 'cols' | 'rows', over: number) => {
    const end = Date.now() + 5000;
    while (size()[dim] <= over && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return size();
  };
  try {
    // An observer's window never sizes the PTY (G17).
    await page.setViewport({ width: 1500, height: 500 });
    await pick(page, 'fit');
    await page.waitForFunction(`${rows}.includes('$')`, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 600));
    const observed = size();
    await page.setViewport({ width: 1100, height: 500 });
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(size(), observed, 'an observer resizes nothing');
    await takeSeat(page, a, 'fit');
    await new Promise((r) => setTimeout(r, 600));
    const short = size();
    await page.setViewport({ width: 1500, height: 500 });
    const wide = await grow('cols', short.cols);
    assert.ok(wide.cols > short.cols + 20, `columns follow the window width: ${JSON.stringify(short)} → ${JSON.stringify(wide)}`);
    await page.setViewport({ width: 1500, height: 1000 });
    const tall = await grow('rows', wide.rows);
    assert.ok(tall.rows > wide.rows + 10, `rows follow the window height: ${JSON.stringify(wide)} → ${JSON.stringify(tall)}`);
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
    const visibilityHelp = await page.evaluate<string>(`document.getElementById('new-vis').title`);
    assert.match(visibilityHelp, /owner principal.*credential/i, 'privacy follows credential identity, not a person or tab');
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
    // A pane holds 64 KB of streamed output; what it drops from the front is said in its summary.
    const bulk = await a.call('run', { session: 'procs', target: 'process', command: `sleep 0.5; head -c 100000 /dev/zero | tr '\\0' x; echo; echo BULK-END-$((4+4))` });
    assert.equal(bulk.state, 'exited');
    await page.waitForFunction(`[...document.querySelectorAll('.run-out')].some((d) => d.textContent.includes('BULK-END-8') && d.querySelector('summary').textContent.includes('not shown'))`, { timeout: 8000 });
    const bulkPane = await page.evaluate<{ summary: string; bytes: number }>(`(() => { const d = [...document.querySelectorAll('.run-out')].find((d) => d.textContent.includes('BULK-END-8')); return { summary: d.querySelector('summary').textContent, bytes: d.querySelector('pre').textContent.length }; })()`);
    assert.ok(bulkPane.bytes <= 64 * 1024 && bulkPane.bytes > 32 * 1024, `the pane keeps the last 64 KB: ${bulkPane.bytes}`);
    assert.match(bulkPane.summary, /first \d+ KB not shown/);

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

// ───────────────────────────── the house's read of 2f357bd (#22) ─────────────────────────────

const controllerOf = (id: string) => {
  const s = registry.get(id);
  assert.ok(s && s.kind === 'live');
  return s.session.currentController;
};

test('2f357bd: no bar before a selection; a paste goes to the session it was typed into, not the one clicked next; Release seat is not undone by a pending resize', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const a = await agent();
  await a.call('session_open', { session: 'pa', visibility: 'shared' });
  await a.call('session_open', { session: 'pb', visibility: 'shared' });
  await a.call('control', { session: 'pb', action: 'release' }); // a stray input to pb would take its free seat
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${port}/?token=tg`, problems);
  try {
    assert.equal(await page.evaluate<string>(`getComputedStyle(document.getElementById('bar')).display`), 'none', 'the action bar waits for a selection');
    await pick(page, 'pa');
    await page.waitForFunction(`${rows}.includes('$')`, { timeout: 10_000 });
    await takeSeat(page, a, 'pa');
    await page.click('#term');
    // The paste and the click on pb in one task: the page's coalescing timer has not fired between them.
    await page.evaluate(`${paste('echo PASTE-TO-PA')}; ${clickSession('pb')}`);
    await page.waitForFunction(`document.getElementById('title').textContent === 'pb' && ${rows}.includes('$')`, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(inputsOf('pa').filter((e) => e.data.includes('PASTE-TO-PA')).length, 1, 'the paste reached pa');
    assert.deepEqual(inputsOf('pb'), [], 'nothing reached pb');
    assert.equal(controllerOf('pb'), null, "pb's seat is still free");
    // Take pb's seat, then release it right after a window change: the resize that change scheduled must not take it back.
    await page.click('#seat-btn');
    await page.waitForFunction(`document.getElementById('seat').textContent === 'you hold the seat'`, { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 500));
    await page.setViewport({ width: 1100, height: 700 });
    await page.click('#seat-btn');
    await page.waitForFunction(`document.getElementById('seat').textContent === 'seat free'`, { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(controllerOf('pb'), null, 'the release stands');
    assert.equal(await page.evaluate<string>(`document.getElementById('seat').textContent`), 'seat free');
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    a.close();
  }
});

test('2f357bd: a process Run’s output from before the attach shows with stderr marked and in order; a cut pane says so; the title and the idle state belong to one session; the Open form says what was ignored', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const a = await agent();
  await a.call('session_open', { session: 'pe', visibility: 'shared' });
  await a.call('session_open', { session: 'pf', visibility: 'shared' });
  // Early output, then a shell line so the early output lies before the snapshot's cursor, then late output after the attach.
  const late = gate();
  const spanning = await a.call('run', { session: 'pe', target: 'process', command: `printf 'EARLY-OUT\\n'; printf 'EARLY-ERR\\n' >&2; ${late.wait}; printf 'LATE-OUT\\n'`, wait: 500 });
  assert.equal(spanning.state, 'running');
  const big = await a.call('run', { session: 'pe', target: 'process', command: 'seq 1 30000' });
  assert.equal(big.state, 'exited');
  await a.call('run', { session: 'pe', command: 'echo MARK-$((1+1))' });
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${port}/?token=tg`, problems);
  const panes = `[...document.querySelectorAll('.run-out')]`;
  try {
    await pick(page, 'pe');
    await page.waitForFunction(`${rows}.includes('MARK-2')`, { timeout: 10_000 });
    late.open();
    await page.waitForFunction(`${panes}.some((d) => d.textContent.includes('LATE-OUT'))`, { timeout: 10_000 });
    await page.evaluate(`${panes}.forEach((d) => { d.open = true; })`);
    await page.waitForFunction(`${panes}.some((d) => d.textContent.includes('EARLY-OUT') && d.textContent.includes('LATE-OUT'))`, { timeout: 8000 });
    const spanningPane = await page.evaluate<{ text: string; stderr: string[] }>(`(() => { const d = ${panes}.find((d) => d.textContent.includes('LATE-OUT')); return { text: d.querySelector('pre').textContent, stderr: [...d.querySelectorAll('.stderr')].map((e) => e.textContent) }; })()`);
    assert.ok(spanningPane.text.indexOf('EARLY-OUT') < spanningPane.text.indexOf('LATE-OUT'), `the early output comes first: ${JSON.stringify(spanningPane.text)}`);
    assert.deepEqual(spanningPane.stderr, ['EARLY-ERR\n'], 'stderr read from the journal is marked apart');
    await page.waitForFunction(`${panes}.some((d) => d.textContent.includes('(cut:'))`, { timeout: 8000 });
    const bigPane = await page.evaluate<string>(`${panes}.find((d) => d.textContent.includes('(cut:')).querySelector('pre').textContent`);
    assert.ok(bigPane.startsWith('1\n2\n3\n'), 'the first lines are there');
    assert.ok(!bigPane.includes('\n30000\n'), 'the last are not');
    assert.match(bigPane, /\(cut: the pane reads at most 64 KB/);

    // The title set while pe is shown does not follow to pf.
    await a.call('run', { session: 'pe', command: `printf '\\033]0;TITLE-OF-PE\\007'; echo TITLED-$((1+1))` });
    await page.waitForFunction(`${info}.includes('TITLE-OF-PE')`, { timeout: 8000 });
    await pick(page, 'pf');
    await page.waitForFunction(`document.getElementById('title').textContent === 'pf' && ${rows}.includes('$')`, { timeout: 10_000 });
    assert.ok(!(await page.evaluate<string>(info)).includes('TITLE-OF-PE'), `pf does not wear pe's title: ${await page.evaluate<string>(info)}`);

    // Cancelling a Run queued behind a running one does not make the bar say idle.
    const slow = await a.call('run', { session: 'pf', command: 'sleep 2; echo SLOW-DONE', wait: 300 });
    assert.equal(slow.state, 'running');
    const queued = await a.call('run', { session: 'pf', command: 'echo QUEUED-BEHIND', queue: true, wait: 0 });
    assert.equal(queued.state, 'queued');
    await a.call('cancel', { session: 'pf', runId: queued.runId as string });
    await page.waitForFunction(`document.getElementById('activity').textContent.includes('cancelled')`, { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    assert.match(await page.evaluate<string>(info), /busy/, 'the shell is still busy');
    await page.waitForFunction(`${rows}.includes('SLOW-DONE')`, { timeout: 8000 });
    await page.waitForFunction(`${info}.includes('idle')`, { timeout: 5000 });

    // Opening an existing shared session as private: the form says the choice did not apply.
    await page.select('#new-vis', 'private');
    await page.evaluate(`document.getElementById('new-name').value = 'pe'`);
    await page.click('#new-form button[type=submit]');
    await page.waitForFunction(`${noticeText}.includes('pe already exists (shared): visibility not changed')`, { timeout: 8000 });
    const pe = registry.get('pe');
    assert.ok(pe && pe.kind === 'live' && pe.session.visibility === 'shared');
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    a.close();
  }
});

test('2f357bd: ^C interrupts the foreground job; Close asks twice; the activity list keeps 200 items', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const a = await agent();
  await a.call('session_open', { session: 'pc', visibility: 'shared' });
  const s = registry.get('pc');
  assert.ok(s && s.kind === 'live');
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${port}/?token=tg`, problems);
  const runOf = (line: string) => s.session.listRuns().find((r) => r.line === line);
  const until = async (ok: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.ok(ok(), 'waited in vain');
  };
  try {
    await pick(page, 'pc');
    await page.waitForFunction(`${rows}.includes('$')`, { timeout: 10_000 });
    await takeSeat(page, a, 'pc');
    await page.click('#term');
    await page.keyboard.type('sleep 30');
    await page.keyboard.press('Enter');
    await until(() => runOf('sleep 30')?.state === 'running', 8000);
    await page.click('#ctrlc');
    await until(() => runOf('sleep 30')?.state !== 'running', 8000);
    const interrupted = runOf('sleep 30')!;
    assert.ok(interrupted.state === 'cancelled' || interrupted.exit === 130, `ended by ^C: ${JSON.stringify(interrupted)}`);
    // Notes beyond 200: the list is trimmed from the end.
    for (let i = 0; i < 230; i++) s.session.journal.append({ type: 'note', text: `note-${i}`, principal: 'agent:g@test' });
    await page.waitForFunction(`document.getElementById('activity').textContent.includes('note-229')`, { timeout: 8000 });
    assert.ok((await page.evaluate<number>(`document.getElementById('activity').childElementCount`)) <= 200);
    // Close: the first click arms, the second closes.
    await page.click('#close');
    assert.equal(await page.evaluate<string>(`document.getElementById('close').textContent`), 'Confirm close');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(registry.get('pc')?.kind, 'live', 'one click closes nothing');
    await page.click('#close');
    await page.waitForFunction(`${noticeText}.includes('closed')`, { timeout: 8000 });
    assert.equal(registry.get('pc')?.kind, 'history');
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    a.close();
  }
});

test('a Close confirmation authorizes only the session that was selected when it was armed', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const a = await agent();
  await a.call('session_open', { session: 'close-arm-one', visibility: 'shared' });
  await a.call('session_open', { session: 'close-arm-two', visibility: 'shared' });
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${port}/?token=tg`, problems);
  try {
    await pick(page, 'close-arm-one');
    await page.waitForFunction(`document.getElementById('title').textContent === 'close-arm-one'`, { timeout: 8000 });
    await page.click('#close');
    assert.equal(await page.evaluate<string>(`document.getElementById('close').textContent`), 'Confirm close');
    await pick(page, 'close-arm-two');
    await page.waitForFunction(`document.getElementById('title').textContent === 'close-arm-two'`, { timeout: 8000 });
    assert.equal(await page.evaluate<string>(`document.getElementById('close').textContent`), 'Close', 'switching sessions disarms the first confirmation');
    await page.click('#close');
    assert.equal(await page.evaluate<string>(`document.getElementById('close').textContent`), 'Confirm close', 'the new session needs its own first click');
    assert.equal(registry.get('close-arm-two')?.kind, 'live', 'the first click closed nothing');
    await page.click('#close');
    await until(() => registry.get('close-arm-two')?.kind === 'history', 8000, 'the confirmed second session closes');
    assert.equal(registry.get('close-arm-one')?.kind, 'live', 'the former session remains open');
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    a.close();
  }
});

test('78c4d6e 20: the output pane trims on a code-point boundary and counts bytes, not UTF-16 units', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const a = await agent();
  await a.call('session_open', { session: 'emoji', visibility: 'shared' });
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${port}/?token=tg`, problems);
  try {
    await pick(page, 'emoji');
    await page.waitForFunction(`document.getElementById('title').textContent === 'emoji' && document.getElementById('node').textContent.includes('agent:g@test')`, { timeout: 8000 });
    const following = () => [...(server as unknown as { conns: Set<{ gui: boolean; followers: Map<string, { state: string }> }> }).conns].some((c) => c.gui && c.followers.get('emoji')?.state === 'live');
    await until(following, 8000, 'the GUI connection to follow emoji before output is produced');
    // ~200 KB of 😀 (four UTF-8 bytes, two UTF-16 units each), streamed live so the pane trims it: the
    // 64 KiB cap is counted in bytes, and the cut falls on a code point, never between a surrogate pair.
    const ran = await a.call('run', { session: 'emoji', target: 'process', command: `awk 'BEGIN { for (i = 0; i < 1000; i++) s = s "\\360\\237\\230\\200"; for (i = 0; i < 50; i++) printf "%s", s; printf "\\nEMOJI-END\\n" }'` });
    assert.equal(ran.state, 'exited');
    await page.waitForFunction(`[...document.querySelectorAll('.run-out')].some((d) => d.textContent.includes('EMOJI-END') && d.querySelector('summary').textContent.includes('not shown'))`, { timeout: 10_000 });
    const pane = await page.evaluate<{ text: string; summary: string }>(`(() => { const d = [...document.querySelectorAll('.run-out')].find((d) => d.textContent.includes('EMOJI-END')); return { text: d.querySelector('pre').textContent, summary: d.querySelector('summary').textContent }; })()`);
    // No lone surrogate anywhere: the front cut did not split a pair.
    assert.doesNotMatch(pane.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'the trimmed pane holds no lone surrogate');
    assert.ok(pane.text.endsWith('\nEMOJI-END\n'), 'the latest streamed suffix survives the trim');
    const keptBytes = Buffer.byteLength(pane.text, 'utf8');
    assert.ok(keptBytes >= 64 * 1024 - 3 && keptBytes <= 64 * 1024, `the pane retains its byte cap without dropping extra spans: ${keptBytes}`);
    // The dropped count is in bytes: about 130 KB of the 200 KB, far more than the ~33 KB a UTF-16-unit count would report.
    const kb = Number(/first (\d+) KB not shown/.exec(pane.summary)?.[1]);
    assert.ok(kb > 100, `the summary counts bytes: ${pane.summary}`);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    a.close();
  }
});
test('G22: history output bytes and streamed output share the GUI pane cap', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const s = 'emoji-history';
  const gate = path.join(dataDir, 'emoji-history-release');
  const glyph = '\\360\\237\\230\\200';
  const command = `awk 'BEGIN { for (i = 0; i < 3000; i++) printf "${glyph}"; fflush() }'; while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.02; done; awk 'BEGIN { for (i = 0; i < 20000; i++) printf "${glyph}"; printf "\\nHISTORY-END\\n" }'`;
  const a = await agent();
  await a.call('session_open', { session: s, visibility: 'shared' });
  const r = await a.call('run', { session: s, target: 'process', command, wait: 0 });
  const runId = r.runId as string;
  assert.ok(runId, 'the process Run was admitted');
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const output = () => live.session.journal.since(0).events.flatMap((e) => e.type === 'output' && e.runId === runId ? [e.data] : []).join('');
  await until(() => Buffer.byteLength(output(), 'utf8') >= 12_000, 8000, 'the pre-attach emoji output');
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${port}/?token=tg`, problems);
  try {
    await page.setViewport({ width: 1100, height: 700 });
    await pick(page, s);
    const pane = `[data-run="${runId}"] .run-out`;
    await page.waitForFunction(`document.getElementById('title').textContent === '${s}' && document.querySelector('${pane} summary')`, { timeout: 8000 });
    await page.click(`${pane} summary`);
    await page.waitForFunction(`document.querySelector('${pane} pre')?.textContent.includes('😀')`, { timeout: 8000 });
    const following = () => [...(server as unknown as { conns: Set<{ gui: boolean; followers: Map<string, { state: string }> }> }).conns].some((c) => c.gui && c.followers.get(s)?.state === 'live');
    await until(following, 8000, 'the GUI to follow history output before the gate opens');
    fs.writeFileSync(gate, '');
    const end = await a.call('await', { session: s, runId, wait: 10_000 });
    assert.equal(end.state, 'exited');
    await page.waitForFunction(`document.querySelector('${pane} pre')?.textContent.includes('HISTORY-END')`, { timeout: 10_000 });
    const shown = await page.evaluate<{ text: string; summary: string }>(`(() => { const d = document.querySelector('${pane}'); return { text: d.querySelector('pre').textContent, summary: d.querySelector('summary').textContent }; })()`);
    const visibleBytes = Buffer.byteLength(shown.text, 'utf8');
    assert.ok(visibleBytes >= 64 * 1024 - 3 && visibleBytes <= 64 * 1024, `the retained suffix fills the byte cap: ${visibleBytes}`);
    assert.ok(shown.text.endsWith('\nHISTORY-END\n'), 'the last streamed suffix remains visible');
    const dropped = Buffer.byteLength(output(), 'utf8') - visibleBytes;
    const kb = Number(/first (\d+) KB not shown/.exec(shown.summary)?.[1]);
    assert.ok(dropped > 20 * 1024 && dropped < 35 * 1024, `both history and streamed bytes contributed to the cut: ${dropped}`);
    assert.equal(kb, Math.round(dropped / 1024), `the summary accounts for non-ASCII history bytes: ${shown.summary}`);
    assert.deepEqual(problems, []);
  } finally {
    fs.writeFileSync(gate, '');
    await page.close();
    a.close();
  }
});

test('the GUI trims many small writes without re-encoding the retained front span', async (t) => {
  if (skip || !browser) return t.skip(skip || 'no browser');
  const s = 'pane-encode-work';
  const a = await agent();
  await a.call('session_open', { session: s, visibility: 'shared' });
  const run = await a.call('run', { session: s, target: 'process', command: 'sleep 30', wait: 0 });
  const runId = run.runId as string;
  assert.ok(runId);
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const problems: string[] = [];
  const page = await openGui(`http://127.0.0.1:${port}/?token=tg`, problems);
  try {
    await page.setViewport({ width: 1100, height: 700 });
    await pick(page, s);
    await page.waitForFunction(`document.getElementById('title').textContent === '${s}' && document.getElementById('node').textContent.includes('agent:g@test')`, { timeout: 8000 });
    const following = () => [...(server as unknown as { conns: Set<{ gui: boolean; followers: Map<string, { state: string }> }> }).conns].some((c) => c.gui && c.followers.get(s)?.state === 'live');
    await until(following, 8000, 'the GUI follower before the synthetic process output');
    const pane = `[data-run="${runId}"] .run-out pre`;
    await page.evaluate(`(() => { const encode = TextEncoder.prototype.encode; window.__encodedUnits = 0; TextEncoder.prototype.encode = function(text) { window.__encodedUnits += text.length; return encode.call(this, text); }; })()`);
    // Feed the same journal-to-follower path as process stdout, with one retained 64 KiB span.
    live.session.journal.append({ type: 'output', data: 'A'.repeat(64 * 1024), stream: 'stdout', runId });
    await page.waitForFunction(`document.querySelector('${pane}')?.textContent.length === ${64 * 1024}`, { timeout: 8000 });
    const baseline = await page.evaluate<number>('window.__encodedUnits');
    for (let i = 0; i < 60; i++) live.session.journal.append({ type: 'output', data: 'x', stream: 'stdout', runId });
    await page.waitForFunction(`document.querySelector('${pane}')?.textContent.endsWith('${'x'.repeat(60)}')`, { timeout: 8000 });
    const view = await page.evaluate<{ text: string; encoded: number }>(`(() => ({ text: document.querySelector('${pane}').textContent, encoded: window.__encodedUnits }))()`);
    assert.equal(view.text.length, 64 * 1024, 'the pane trims each byte while retaining its suffix');
    assert.ok(view.encoded - baseline < 1024, `small appends encoded only small input, not the retained span: ${view.encoded - baseline} UTF-16 units`);
    assert.deepEqual(problems, []);
  } finally {
    await a.call('cancel', { session: s, runId }).catch(() => {});
    await page.close();
    a.close();
  }
});
