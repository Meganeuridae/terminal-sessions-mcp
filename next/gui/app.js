// Terminal Sessions GUI — a native client of termd (DESIGN §12).
//
// It attaches to a session with a snapshot at cursor N and then receives every
// journal event after N (G13). Its emulator never answers terminal queries: the
// daemon's emulator is the sole responder (G25), so the query handlers below
// swallow them. It types only while holding the controller seat (G17), and it
// never resizes the PTY unless it holds the seat; observers see the terminal at
// the controller's size.
//
// Keystrokes are sent only over an open connection to an attached session: typed
// while disconnected or attaching, they are dropped with a notice, never queued to
// run seconds later against whatever the terminal shows by then (tsg-7). Input can
// be marked secret (the lock), and is automatically while the cursor line looks
// like a password prompt: the daemon journals it as a redacted placeholder (G26,
// tsg-8). The session list is pushed by the daemon on change (terminal/sessions)
// and refreshed slowly only while the page is visible (tsg-16).
'use strict';
(() => {
  // The token arrives once in the page URL (`tsm gui` prints it). Keep it for this tab only and take it
  // out of the address bar, so it is not left on screen, in bookmarks or in shared screenshots.
  const params = new URLSearchParams(location.search);
  let token = params.get('token');
  try {
    if (token) sessionStorage.setItem('tsm-token', token);
    else token = sessionStorage.getItem('tsm-token');
  } catch {
    // storage blocked: the token lives only as long as this page
  }
  if (params.has('token')) {
    params.delete('token');
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash);
  }
  // A label for the daemon's logs; the daemon assigns the connection's real identity.
  const connectionId = 'gui-' + Math.random().toString(36).slice(2, 10);

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.dataset.theme = 'light';

  // ───────────── JSON-RPC over WebSocket, reconnecting ─────────────

  class Rpc {
    constructor(onStatus) {
      this.nextId = 1;
      this.pending = new Map();
      this.handlers = new Map();
      this.waiters = [];
      this.backoff = 500;
      this.failures = 0; // consecutive attempts that never opened
      this.onStatus = onStatus;
      this.connect();
    }
    url() {
      const q = new URLSearchParams({ connection: connectionId, profile: 'full', resultText: 'json' });
      if (token) q.set('token', token);
      return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?${q}`;
    }
    get open() {
      return this.ws.readyState === WebSocket.OPEN;
    }
    connect() {
      const ws = (this.ws = new WebSocket(this.url()));
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.failures = 0;
        this.backoff = 500;
        this.onStatus(true);
        for (const w of this.waiters.splice(0)) w();
        this.emit('open');
      };
      ws.onclose = () => {
        // A browser never learns why an upgrade was refused (401, 403, 421); say what to check.
        if (!opened && ++this.failures === 3) notice('Cannot connect. Is termd running, and does this URL carry the right token? `tsm gui` prints it.');
        this.onStatus(false);
        for (const p of this.pending.values()) p.reject(new Error('connection closed'));
        this.pending.clear();
        this.emit('close');
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 8000);
      };
      ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.method === undefined) {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code, data: m.error.data }));
          else p.resolve(m.result);
          return;
        }
        if (m.id !== undefined) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported by the GUI' } }));
          return;
        }
        this.emit(m.method, m.params);
      };
    }
    ready() {
      return this.open ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
    }
    /** `queue: false`: fail at once while disconnected instead of waiting for the next connection (keystrokes, tsg-7). */
    async request(method, params, { queue = true } = {}) {
      if (!queue && !this.open) throw new Error('not connected');
      await this.ready();
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    }
    on(method, h) {
      if (!this.handlers.has(method)) this.handlers.set(method, []);
      this.handlers.get(method).push(h);
    }
    emit(method, p) {
      for (const h of this.handlers.get(method) ?? []) h(p);
    }
  }

  const rpc = new Rpc((up) => {
    $('conn-dot').className = 'dot ' + (up ? 'ok' : 'bad');
    $('conn-text').textContent = up ? 'connected' : 'reconnecting';
  });

  /** A tool call acts now or not at all: while disconnected it fails at once, never runs later by surprise (tsg-7). */
  async function tool(name, args, opts = { queue: false }) {
    const r = await rpc.request('tools/call', { name, arguments: args }, opts);
    if (r.isError) throw new Error(r.content?.[0]?.text ?? `${name} failed`);
    return r.structuredContent;
  }

  // ───────────── state ─────────────

  const state = {
    me: null,
    sessions: [],
    current: null, // session id
    attachSeq: 0, // bumps on every attach, so a stale attach response is ignored
    attaching: false, // while true, stream events belong to the stream the new snapshot replaces
    role: 'observer',
    controller: null,
    lastSeq: 0,
    attachedAt: 0, // the cursor the attach's snapshot (or transcript) reflects: everything after it streams
    exited: false,
    history: false,
    streamEnded: false, // the daemon ended this session's stream (closed, removed, a read error, or a failed attach)
    behind: false, // output outran the emulator: it is not fed until a fresh snapshot replaces the screen
    liveState: null, // the shell's state as the journal tells it (run.start/run.end/screen.mode), newer than the list's
    running: new Set(), // shell Runs that started and have not ended: the shell is busy while any remains
    runs: new Map(), // runId → {line, principal, target, item, out}
    typing: null, // {principal, text, code}: the line another principal is typing, shown as it grows
  };
  let term = null;
  let fit = null;
  let resizeTimer = null;

  function notice(text) {
    const n = $('notice');
    n.textContent = text ?? '';
    n.style.display = text ? 'block' : 'none';
  }

  // ───────────── sessions list ─────────────

  /** Pushed by the daemon on change (`terminal/sessionsChanged`); the slow poll only catches state and seat changes elsewhere. */
  let listing = null;
  function refreshSessions() {
    listing ??= refreshNow().finally(() => {
      listing = null;
    });
    return listing;
  }

  async function refreshNow() {
    try {
      const r = await rpc.request('terminal/sessions', { watch: true });
      state.sessions = r.sessions ?? [];
    } catch {
      return;
    }
    const now = state.sessions.find((x) => x.id === state.current);
    if (state.current && !now) notice('This session was removed.');
    // The session got a new life (a restart after it was closed, exited or recovered): attach to it (tsg-9).
    else if (state.current && now && isLive(now) && (state.history || state.exited || state.streamEnded)) reattach();
    const box = $('sessions');
    box.replaceChildren();
    if (!state.sessions.length) box.append(el('div', 'empty', 'No sessions'));
    for (const s of state.sessions) {
      const item = el('div', 'session' + (s.id === state.current ? ' active' : ''));
      item.append(el('div', 'name', s.id));
      const bits = [s.state + (s.closed ? ' (closed)' : s.recovered ? ` (${s.recovered})` : ''), s.controller ? `seat ${s.controller}` : 'seat free'];
      if (s.visibility === 'private') bits.push('private');
      if (s.cwd) bits.push(s.cwd);
      item.append(el('div', 'meta', bits.join(' · ')));
      item.title = `owner ${s.owner}`;
      item.onclick = () => select(s.id);
      box.append(item);
    }
    if (state.current) updateBar();
  }

  const isLive = (s) => !s.closed && !s.recovered && s.state !== 'exited';

  let pushedTimer = null;
  rpc.on('terminal/sessionsChanged', () => {
    clearTimeout(pushedTimer);
    pushedTimer = setTimeout(refreshSessions, 100);
  });
  // A slow look for what the registry does not announce (another session's state or seat), only while someone can see it.
  setInterval(() => {
    if (document.visibilityState === 'visible' && rpc.open) refreshSessions();
  }, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && rpc.open) refreshSessions();
  });

  // ───────────── the terminal ─────────────

  /** G25: the daemon answers terminal queries; this emulator must not. */
  function swallowQueries(t) {
    const p = t.parser;
    const yes = () => true;
    p.registerCsiHandler({ final: 'n' }, yes); // DSR, CPR
    p.registerCsiHandler({ prefix: '?', final: 'n' }, yes); // DEC DSR
    p.registerCsiHandler({ final: 'c' }, yes); // DA1
    p.registerCsiHandler({ prefix: '>', final: 'c' }, yes); // DA2
    p.registerCsiHandler({ prefix: '=', final: 'c' }, yes); // DA3
    p.registerCsiHandler({ intermediates: '$', final: 'p' }, yes); // DECRQM (ANSI)
    p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, yes); // DECRQM (DEC)
    p.registerCsiHandler({ prefix: '>', final: 'q' }, yes); // XTVERSION
    const reports = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);
    p.registerCsiHandler({ final: 't' }, (ps) => reports.has(Number(ps[0]))); // window reports
    for (const n of [4, 10, 11, 12, 17, 19]) p.registerOscHandler(n, (data) => data.includes('?')); // colour queries
    p.registerDcsHandler({ intermediates: '$', final: 'q' }, yes); // DECRQSS
    p.registerDcsHandler({ intermediates: '+', final: 'q' }, yes); // XTGETTCAP
  }

  function makeTerminal(cols, rows) {
    if (term) term.dispose();
    $('term').replaceChildren();
    term = new Terminal({
      cols,
      rows,
      scrollback: 10000,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, "Cascadia Code", monospace',
      theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
    });
    swallowQueries(term);
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('term'));
    term.onData(send);
    term.onBinary(send);
    pendingBytes = 0;
    state.behind = false;
  }

  // ───────────── typing: never queued, secret when asked or when it looks like a password prompt ─────────────

  /** A no-echo prompt's usual last line: `Password:`, `[sudo] password for x:`, `Enter passphrase for key …:`, `PIN:`. */
  const SECRET_PROMPT = /(pass(word|phrase|code)?|\bpin\b|passcode|\botp\b|one-time code|verification code|secret|token)[^\n]{0,80}[:?]\s*$/i;
  const secret = { manual: false, auto: false };

  function cursorLine() {
    if (!term) return '';
    const b = term.buffer.active;
    return b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '';
  }

  function updateSecret() {
    const btn = $('secret');
    const on = secret.manual || secret.auto;
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
    btn.textContent = secret.manual ? 'Secret: on' : secret.auto ? 'Secret: auto' : 'Secret: off';
    btn.title = on ? 'What you type is sent as sensitive input: the journal keeps a placeholder, observers see [redacted]' : 'Send what you type as sensitive input (journaled redacted)';
  }

  $('secret').onclick = () => {
    secret.manual = !secret.manual;
    if (!secret.manual) secret.auto = false;
    updateSecret();
    term?.focus();
  };

  let typedAhead = '';
  let typedFor = null; // the session the text was typed into: it goes there even if another is selected before it is sent
  let typedSecret = false;
  let sendTimer = null;
  function send(data) {
    if (!state.current || state.history || state.exited) return;
    if (state.role !== 'controller') {
      notice('You are observing. Take the seat to type.');
      return;
    }
    // tsg-7: typed while disconnected or while (re)attaching, it goes nowhere — and says so. Nor after the
    // stream ended: the page no longer shows what the input would land on (the house's read of 2f357bd, #22).
    if (!rpc.open || state.attaching || state.streamEnded) {
      notice(
        !rpc.open
          ? 'Not connected: that input was not sent.'
          : state.attaching
            ? 'Attaching: that input was not sent. Type again once the terminal is back.'
            : 'The live stream ended: that input was not sent. Click the session to reattach.',
      );
      return;
    }
    // G26: a password prompt on the cursor line makes this input secret until the line is entered.
    if (!secret.manual && !secret.auto && SECRET_PROMPT.test(cursorLine())) {
      secret.auto = true;
      updateSecret();
    }
    // A burst (paste, key repeat) is one input call; secret and plain text never share one.
    const sensitive = secret.manual || secret.auto;
    if (typedAhead && sensitive !== typedSecret) flush();
    typedSecret = sensitive;
    if (!typedAhead) typedFor = state.current;
    typedAhead += data;
    if (sensitive && secret.auto && /[\r\n]/.test(data)) {
      secret.auto = false;
      updateSecret();
    }
    if (sendTimer) return;
    sendTimer = setTimeout(flush, 4);
  }

  function flush() {
    clearTimeout(sendTimer);
    sendTimer = null;
    const text = typedAhead;
    typedAhead = '';
    if (!text) return;
    // The session it was typed into, not the one selected now: a paste followed at once by a click on
    // another session went to that session, and took its free seat (the house's read of 2f357bd, #22).
    const args = { session: typedFor, text };
    if (typedSecret) args.sensitive = true;
    tool('input', args).catch((e) =>
      notice(
        e.message === 'not connected'
          ? 'Not connected: that input was not sent.'
          : e.message === 'connection closed'
            ? 'The connection dropped while that input was on its way: it may or may not have reached the terminal, and it is not resent (G16).'
            : e.message,
      ),
    );
  }

  rpc.on('close', () => {
    // Anything still coalescing is dropped with the connection, not sent after it comes back.
    clearTimeout(sendTimer);
    sendTimer = null;
    if (typedAhead) notice('Not connected: that input was not sent.');
    typedAhead = '';
  });

  /** The controller sizes the PTY to its view — columns and rows (tsg-11); observers keep the controller's size (G17). */
  const canResize = () => term && state.role === 'controller' && !state.history && !state.exited && !state.streamEnded;
  function maybeResize() {
    if (!canResize()) return;
    clearTimeout(resizeTimer);
    const id = state.current;
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      // Checked again when the timer fires: the daemon gives a free seat to whoever acts first, so a resize
      // sent after Release seat took the seat back (the house's read of 2f357bd, #22).
      if (!canResize() || state.current !== id) return;
      const d = fit.proposeDimensions();
      if (!d || !d.cols || !d.rows) return;
      const cols = Math.max(20, Math.min(500, d.cols));
      const rows = Math.max(5, Math.min(200, d.rows));
      if (cols === term.cols && rows === term.rows) return;
      tool('resize', { session: id, cols, rows }).catch(() => undefined);
    }, 150);
  }
  window.addEventListener('resize', maybeResize);
  if (window.ResizeObserver) new ResizeObserver(maybeResize).observe($('term-wrap'));

  // ───────────── attach and events ─────────────

  async function select(id) {
    // Clicking the current session again reattaches when its stream ended (closed, exited, history; tsg-9).
    if (state.current === id && !(state.exited || state.history || state.streamEnded)) return;
    // Text still coalescing was typed into the session being left: it goes there, now.
    flush();
    if (state.current && state.current !== id) rpc.request('terminal/detach', { session: state.current }).catch(() => undefined);
    state.current = id;
    state.runs.clear();
    state.running.clear();
    state.typing = null;
    state.lastSeq = 0;
    state.liveState = null;
    // The bar's cwd, title and mode belong to the session that produced them (the house's read of 2f357bd, #22).
    cwd = '';
    title = '';
    alt = false;
    secret.auto = false;
    updateSecret();
    $('activity').replaceChildren();
    $('empty').style.display = 'none';
    $('bar').hidden = false;
    notice('');
    await attach(id);
    refreshSessions();
  }

  async function attach(id) {
    const mine = ++state.attachSeq;
    // Until the response, events on the wire come from the previous stream (the daemon starts the new
    // one only after the response): the snapshot supersedes them, so they are not applied (G13).
    state.attaching = true;
    let r;
    try {
      r = await rpc.request('terminal/attach', { session: id, role: 'auto' });
    } catch (e) {
      if (state.current === id && state.attachSeq === mine) attachFailed(e);
      return;
    } finally {
      if (state.attachSeq === mine) state.attaching = false;
    }
    if (state.current !== id || state.attachSeq !== mine) return;
    state.me = r.principal;
    $('node').textContent = r.principal ? `you are ${r.principal}` : '';
    state.role = r.role;
    state.controller = r.controller;
    state.history = !r.snapshot;
    state.exited = r.info?.state === 'exited';
    state.streamEnded = false;
    state.liveState = r.info?.state ?? null;
    if (r.snapshot) {
      makeTerminal(r.snapshot.cols, r.snapshot.rows);
      writeTerm(r.snapshot.data);
      state.lastSeq = r.snapshot.seq;
      alt = Boolean(r.snapshot.alt);
    } else {
      makeTerminal(120, 30);
      writeTerm((r.transcript ?? '').replace(/\r?\n/g, '\r\n'));
      state.lastSeq = r.lastSeq ?? 0;
      notice(
        r.info?.closed
          ? 'This session was closed; its history stays readable. Running a command in it (as its owner) starts a new shell.'
          : r.info?.recovered
            ? `History only (${r.info.recovered}): this shell ended with a previous daemon.`
            : 'History only.',
      );
    }
    state.attachedAt = state.lastSeq;
    for (const run of r.runs ?? []) {
      showRun(run);
      if (run.target !== 'process' && (run.state === 'running' || run.state === 'starting')) state.running.add(run.runId);
    }
    updateBar();
    maybeResize();
    term.focus();
  }

  /**
   * Nothing of the session is attached: the previous session's screen and seat must not stand in for it,
   * and a click on it tries again (the house's read of 2f357bd, #22).
   */
  function attachFailed(e) {
    if (term) term.dispose();
    term = null;
    $('term').replaceChildren();
    $('empty').style.display = '';
    state.role = 'observer';
    state.controller = null;
    state.history = false;
    state.exited = false;
    state.streamEnded = true;
    state.behind = false;
    updateBar();
    notice(`Could not attach: ${e.message} Click the session to try again.`);
  }

  /**
   * A fresh snapshot of the current session, then the events after it (after a gap, a reconnect or a
   * new life). At most one a second, so a flapping stream cannot loop; one asked for sooner is deferred,
   * not dropped (a session closed and restarted within the second still gets its new life shown).
   */
  let lastReattach = 0;
  let deferredReattach = null;
  function reattach() {
    if (!state.current) return;
    const wait = lastReattach + 1000 - Date.now();
    if (wait > 0) {
      deferredReattach ??= setTimeout(() => {
        deferredReattach = null;
        reattach();
      }, wait);
      return;
    }
    lastReattach = Date.now();
    const id = state.current;
    state.current = null;
    select(id);
  }

  rpc.on('open', async () => {
    await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tsm-gui', version: '1' } }).catch(() => undefined);
    refreshSessions();
    // Reattach after a reconnect: a fresh snapshot, then events after it.
    if (state.current) {
      lastReattach = 0;
      reattach();
    }
  });

  // G11/G13: the daemon says when retention passed our cursor; the screen can only be rebuilt from a snapshot.
  rpc.on('terminal/gap', ({ session, from, to }) => {
    if (session !== state.current || state.attaching) return;
    notice(`Events ${from}–${to} were not retained; reattached with a fresh snapshot.`);
    reattach();
  });

  // The stream for a session ended: it was closed, or the daemon could not read its journal. Show what is left (tsg-9).
  rpc.on('terminal/closed', ({ session, reason }) => {
    if (session !== state.current) return;
    state.streamEnded = true;
    updateBar();
    if (reason === 'session-closed') {
      lastReattach = 0;
      reattach(); // the history view: transcript and Runs
    } else if (reason === 'session-removed') notice('This session was removed.');
    else notice('The live stream ended; click the session to reattach.');
    refreshSessions();
  });

  rpc.on('terminal/event', ({ session, event }) => {
    if (session !== state.current || !term || state.attaching) return;
    if (event.seq <= state.lastSeq) return;
    if (event.seq !== state.lastSeq + 1 && state.lastSeq > 0) {
      // Never expected: the daemon delivers every event after the snapshot. Rebuild rather than show a torn screen.
      reattach();
      return;
    }
    state.lastSeq = event.seq;
    switch (event.type) {
      case 'output':
        if (event.stream === 'pty') writeTerm(event.data);
        else runOutput(event); // a process Run's stdout/stderr: its own pane, never the shell's screen (G14, tsg-23)
        return;
      case 'resize':
        // Behind the output written before it, so those bytes are laid out at the size they were produced
        // for; applied at once, it overtook output still queued (the house's read of 2f357bd, #22).
        writeTerm('', () => term.resize(event.cols, event.rows));
        return;
      case 'control':
        state.controller = event.controller;
        state.role = event.controller === state.me ? 'controller' : 'observer';
        activity(`seat ${event.controller ? `taken by ${event.controller}` : 'released'} (${event.how})`, event.by);
        updateBar();
        if (state.role === 'controller') maybeResize();
        return;
      case 'run.admit':
        // Merge: the attach snapshot may already list this Run (with its row).
        Object.assign(runRec(event.runId), { line: event.line ?? (event.argv ?? []).join(' '), principal: event.principal, target: event.target });
        return;
      case 'run.start': {
        const r = runRec(event.runId);
        if (event.line && !r.line) r.line = event.line;
        showRun({ runId: event.runId, state: 'running' });
        if (r.target !== 'process') {
          state.running.add(event.runId);
          setLiveState('busy');
        }
        return;
      }
      case 'run.end': {
        showRun({ runId: event.runId, state: event.state, exit: event.exit, signal: event.signal, reason: event.reason, durationMs: event.durationMs });
        // Only the end of a Run that held the shell frees it: a Run cancelled while queued behind a running
        // one never did, and the bar said idle too soon (the house's read of 2f357bd, #22).
        if (state.running.delete(event.runId) && state.running.size === 0) setLiveState('idle');
        return;
      }
      case 'input':
        if (event.kind === 'protocol-reply' || event.principal === state.me) return;
        showTyping(event.principal, event.sensitive ? '[redacted]' : event.data);
        return;
      case 'note':
        // What an agent said on the session's channel (§10.1): shown to the humans watching (mcpl-14).
        activity(el('div', 'note', event.text), `${event.principal} noted`);
        state.typing = null;
        return;
      case 'session.exit':
        state.exited = true;
        state.liveState = 'exited';
        notice(`The shell exited${event.code !== null && event.code !== undefined ? ` with code ${event.code}` : ''}. History stays readable; a new command from its owner starts a new shell.`);
        updateBar();
        refreshSessions();
        return;
      case 'gap':
        notice(`Events ${event.from}–${event.to} were not retained.`);
        return;
      case 'screen.mode':
        setLiveState(event.alt ? 'tui' : state.liveState === 'tui' ? 'busy' : state.liveState);
        updateBar(event);
        return;
      case 'cwd':
      case 'title':
        updateBar(event);
        return;
      default:
        return;
    }
  });

  function setLiveState(s) {
    if (state.exited) return;
    state.liveState = s;
    updateBar();
  }

  /**
   * Output goes through xterm's write queue, which parses it later; `pendingBytes` is what it has not drawn
   * yet. Past PENDING_MAX the page has fallen behind: it stops feeding the queue and rebuilds the screen
   * from a fresh snapshot, instead of letting xterm throw the output away at 50 MB while the page counted
   * it as shown (the house's read of 2f357bd, #22). `then` runs once the data before it is drawn.
   */
  const PENDING_MAX = 16 * 1024 * 1024;
  let pendingBytes = 0;
  function writeTerm(data, then) {
    if (state.behind) return;
    if (pendingBytes + data.length > PENDING_MAX) return fellBehind();
    const t = term;
    pendingBytes += data.length;
    try {
      t.write(data, () => {
        if (term !== t) return;
        pendingBytes -= data.length;
        if (then) then();
      });
    } catch {
      pendingBytes -= data.length;
      fellBehind();
    }
  }

  function fellBehind() {
    state.behind = true;
    notice('Output arrived faster than this page could draw it: the screen is being rebuilt from a snapshot.');
    reattach();
  }

  // ───────────── activity panel ─────────────

  function activity(text, who, cls) {
    const item = el('div', 'item');
    if (who) item.append(el('div', 'who', who));
    const body = el('div', cls);
    body.append(text instanceof Node ? text : document.createTextNode(text));
    item.append(body);
    $('activity').prepend(item);
    while ($('activity').childElementCount > 200) {
      const gone = $('activity').lastElementChild;
      // A Run's record, and the output its pane held, go with its item (the house's read of 2f357bd, #22).
      if (gone.dataset.run) state.runs.delete(gone.dataset.run);
      gone.remove();
    }
    return item;
  }

  /** A Run's record: its line, who ran it, its target, its activity item and output pane. */
  function runRec(runId, target = 'shell') {
    if (!state.runs.has(runId)) state.runs.set(runId, { line: '', principal: '?', target });
    return state.runs.get(runId);
  }

  function showRun(run) {
    const rec = runRec(run.runId);
    if (run.line) rec.line = run.line;
    if (run.principal) rec.principal = run.principal;
    if (run.target) rec.target = run.target;
    const code = el('code', null, (rec.target === 'process' ? '⚙ ' : '$ ') + (rec.line || run.runId));
    const status = el('div', 'dim');
    const st = run.state;
    if (st === 'exited') {
      const how = run.exit !== undefined && run.exit !== null ? `exit ${run.exit}` : run.signal ? `killed by ${run.signal}` : 'exit ?';
      status.textContent = `${how}${run.durationMs !== undefined ? ` · ${fmt(run.durationMs)}` : ''}`;
      status.className = run.exit === 0 ? 'ok' : 'bad';
    } else if (st === 'cancelled') {
      status.textContent = `cancelled${run.signal ? ` by ${run.signal}` : ''}`;
      status.className = 'bad';
    } else if (st === 'lost') {
      status.textContent = `outcome unknown: ${run.reason ?? 'lost'}`;
      status.className = 'bad';
    } else status.textContent = st ?? 'running';
    rec.state = st;
    const frag = document.createDocumentFragment();
    frag.append(code, status);
    if (rec.target === 'process') frag.append(outputPane(run.runId, rec));
    if (rec.item) {
      rec.item.replaceChildren(el('div', 'who', `${rec.principal} · ${run.runId}`), frag);
    } else {
      rec.item = activity(frag, `${rec.principal} · ${run.runId}`);
      rec.item.dataset.run = run.runId;
    }
    state.typing = null;
  }

  // ───────────── a process Run's output (tsg-23) ─────────────

  const OUT_MAX = 64 * 1024;

  /**
   * An expandable pane under the Run's activity item: its stdout and stderr, stderr marked apart. Output
   * from before this page attached is in the journal: read on demand when the pane is opened, as events
   * so stderr stays marked, up to the attach cursor (what came after it streamed to the page), and put
   * before what streamed. Every cut is marked where it is (the house's read of 2f357bd, #22).
   */
  function outputPane(runId, rec) {
    if (!rec.out) {
      const details = el('details', 'run-out');
      const summary = el('summary', null, 'output');
      const pre = el('pre');
      details.append(summary, pre);
      rec.out = { details, pre, bytes: 0, cut: 0, stderr: false, loaded: false };
      details.addEventListener('toggle', () => {
        if (!details.open || rec.out.loaded) return;
        rec.out.loaded = true;
        const args = { session: state.current, runId, as: 'events', maxBytes: OUT_MAX / 4, limit: 2000 };
        if (state.attachedAt > 0) args.until = state.attachedAt;
        tool('read', args)
          .then((r) => earlierOut(rec, r))
          .catch((e) => appendOut(rec, { stream: 'stderr', data: `(could not read the output: ${e.message})` }));
      });
    }
    return rec.out.details;
  }

  const outSpan = (stream, data) => el('span', stream === 'stderr' ? 'stderr' : null, data);
  const cutMark = (text) => el('span', 'cut', `(${text})\n`);
  const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

  /** The journal's part of a Run's output goes before the streamed part, with any hole or cut marked. */
  function earlierOut(rec, r) {
    const out = rec.out;
    const frag = document.createDocumentFragment();
    for (const e of r.events ?? []) {
      if (e.type === 'gap') frag.append(cutMark(`output ${e.from}–${e.to} not retained`));
      if (e.type !== 'output') continue;
      frag.append(outSpan(e.stream, e.data));
      out.bytes += e.data.length;
      if (e.stream === 'stderr') out.stderr = true;
    }
    if (r.more) frag.append(cutMark(`cut: the pane reads at most ${kb(OUT_MAX)} of the earlier output; the read tool pages all of it`));
    out.pre.prepend(frag);
    trimOut(out);
  }

  function appendOut(rec, { stream, data }) {
    const out = rec.out;
    out.pre.append(outSpan(stream, data));
    out.bytes += data.length;
    if (stream === 'stderr') out.stderr = true;
    trimOut(out);
  }

  /**
   * The pane holds the last OUT_MAX; what the front loses is counted and said in the summary, never passed
   * off as whole. The span that straddles the cap is shortened rather than dropped: a pipe hands the page
   * chunks of up to 64 KiB, and dropping one whole could leave the pane nearly empty.
   */
  function trimOut(out) {
    while (out.bytes > OUT_MAX && out.pre.firstChild) {
      const first = out.pre.firstChild;
      if (first.classList.contains('cut')) {
        first.remove();
        continue;
      }
      const excess = out.bytes - OUT_MAX;
      const n = first.textContent.length;
      if (n <= excess) {
        out.bytes -= n;
        out.cut += n;
        first.remove();
      } else {
        first.textContent = first.textContent.slice(excess);
        out.bytes -= excess;
        out.cut += excess;
      }
    }
    const parts = [`output (${out.stderr ? 'stdout + stderr' : 'stdout'})`];
    if (out.cut) parts.push(`first ${kb(out.cut)} not shown`);
    out.details.querySelector('summary').textContent = parts.join(' · ');
  }

  function runOutput(event) {
    if (!event.runId) return;
    const rec = runRec(event.runId, 'process');
    if (!rec.item) showRun({ runId: event.runId, state: rec.state ?? 'running' });
    outputPane(event.runId, rec);
    appendOut(rec, event);
  }

  function showTyping(principal, data) {
    const printable = data.replace(/\r/g, '⏎').replace(/\x7f/g, '⌫').replace(/[\x00-\x1f]/g, (c) => `^${String.fromCharCode(c.charCodeAt(0) + 64)}`);
    if (state.typing && state.typing.principal === principal && !state.typing.text.endsWith('⏎')) {
      state.typing.text += printable;
      state.typing.code.textContent = state.typing.text;
      return;
    }
    const code = el('code', null, printable);
    activity(code, `${principal} typed`);
    state.typing = { principal, text: printable, code };
  }

  const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

  // ───────────── bar and actions ─────────────

  let cwd = '';
  let title = '';
  let alt = false;
  function updateBar(ev) {
    if (ev?.type === 'cwd') cwd = ev.path;
    if (ev?.type === 'title') title = ev.text;
    if (ev?.type === 'screen.mode') alt = ev.alt;
    const s = state.sessions.find((x) => x.id === state.current);
    if (!ev && s?.cwd) cwd = s.cwd;
    $('title').textContent = state.current ?? '';
    const info = [];
    if (state.exited || state.history) info.push(s?.closed ? 'closed' : 'exited');
    else if (state.liveState || s) info.push(state.liveState ?? s.state);
    if (state.streamEnded && !state.history) info.push('stream ended');
    if (cwd) info.push(cwd);
    if (alt) info.push('full-screen program');
    if (title) info.push(`“${title}”`);
    $('info').textContent = info.join(' · ');
    const seat = $('seat');
    const mine = state.controller && state.controller === state.me;
    seat.textContent = state.controller ? (mine ? 'you hold the seat' : `seat: ${state.controller}`) : 'seat free';
    seat.className = 'seat' + (mine ? ' mine' : '');
    const btn = $('seat-btn');
    btn.textContent = mine ? 'Release seat' : 'Take seat';
    btn.disabled = state.history || state.exited;
    $('ctrlc').disabled = !mine || state.exited || state.history;
    $('secret').disabled = !mine || state.exited || state.history;
    $('close').disabled = state.exited && state.history;
  }

  $('seat-btn').onclick = async () => {
    if (!state.current) return;
    const mine = state.controller === state.me;
    if (mine) {
      // Releasing: no resize of ours may follow and take the seat back (the house's read of 2f357bd, #22).
      clearTimeout(resizeTimer);
      resizeTimer = null;
      state.role = 'observer';
    }
    try {
      const r = await tool('control', { session: state.current, action: mine ? 'release' : 'take' });
      state.controller = r.controller;
      notice('');
    } catch (e) {
      notice(e.message);
    }
    state.role = state.controller && state.controller === state.me ? 'controller' : 'observer';
    updateBar();
    maybeResize();
    term?.focus();
  };

  $('ctrlc').onclick = () => {
    if (state.current) tool('signal', { session: state.current, signal: 'SIGINT' }).catch((e) => notice(e.message));
  };

  let closeArmed = null;
  $('close').onclick = async () => {
    if (!state.current) return;
    if (!closeArmed) {
      $('close').textContent = 'Confirm close';
      closeArmed = setTimeout(() => {
        closeArmed = null;
        $('close').textContent = 'Close';
      }, 3000);
      return;
    }
    clearTimeout(closeArmed);
    closeArmed = null;
    $('close').textContent = 'Close';
    try {
      await tool('session_close', { session: state.current });
    } catch (e) {
      notice(e.message);
    }
    refreshSessions();
  };

  // Who may see a session opened here (§9): private (you only — not even agents using your token) or shared.
  // The choice is remembered per browser, a convenience only: storage may be blocked.
  try {
    if (localStorage.getItem('tsm-new-visibility') === 'shared') $('new-vis').value = 'shared';
  } catch {}
  $('new-vis').onchange = () => {
    try {
      localStorage.setItem('tsm-new-visibility', $('new-vis').value);
    } catch {}
  };

  $('new-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('new-name').value.trim();
    if (!name) return;
    try {
      const r = await tool('session_open', { session: name, visibility: $('new-vis').value });
      $('new-name').value = '';
      await refreshSessions();
      await select(name);
      // The session existed, so the form's choices did not apply: say so, as the tool's result does
      // (the house's read of 2f357bd, #22).
      if (r.ignored?.length) notice(`${name} already exists${r.info?.visibility ? ` (${r.info.visibility})` : ''}: ${r.ignored.join(', ')} not changed.`);
    } catch (err) {
      notice(err.message);
    }
  };

  updateSecret();
})();
