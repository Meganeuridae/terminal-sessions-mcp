#!/usr/bin/env bun
/**
 * Milestone-1 acceptance against Claude Code's MCPL host: mcpl-cc-bridge's own
 * McplServerHandle and WakeGate (the classes the plugin runs), under bun.
 * termd runs as a child process (node) on a free port.
 *
 *   bun next/acceptance/bridge.ts          (after npm run build:next)
 *
 * Checks the milestone sentence through the bridge, the wake decision for a
 * completion, and that publish (mcpl_send) never types into the shell.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

// The bridge repository's layout on its main is plugins/mcpl-bridge/src; an older checkout has a
// bridge/ directory above it. MCPL_BRIDGE names the src directory directly.
const BRIDGE_CANDIDATES = ['../../../mcpl-cc-bridge/plugins/mcpl-bridge/src', '../../../mcpl-cc-bridge/bridge/plugins/mcpl-bridge/src'].map((p) => path.resolve(import.meta.dir, p))
const BRIDGE = process.env.MCPL_BRIDGE ?? BRIDGE_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'mcpl-host.ts'))) ?? BRIDGE_CANDIDATES[0]!
if (!fs.existsSync(path.join(BRIDGE, 'mcpl-host.ts'))) {
  // In CI the host is checked out on purpose (ACCEPTANCE_REQUIRED=1): a missing one is a failure, not a skip.
  console.log(`${process.env.ACCEPTANCE_REQUIRED === '1' ? 'FAIL' : 'skip'}: mcpl-cc-bridge not found at ${BRIDGE} (set MCPL_BRIDGE)`)
  process.exit(process.env.ACCEPTANCE_REQUIRED === '1' ? 1 : 0)
}
const { McplServerHandle } = await import(path.join(BRIDGE, 'mcpl-host.ts'))
const { WakeGate } = await import(path.join(BRIDGE, 'wake.ts'))

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fail = (msg: string): never => {
  throw new Error(msg)
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-accept-bridge-'))
const tokens = path.join(tmp, 'tokens.json')
fs.writeFileSync(tokens, JSON.stringify({ ta: 'agent:claude@test', tb: 'agent:observer@test' }), { mode: 0o600 })
const port = await freePort()
const termd = spawn('node', [path.resolve(import.meta.dir, '../dist/src/daemon.js'), '--port', String(port), '--data-dir', path.join(tmp, 'data'), '--tokens-file', tokens, '--shell', '/bin/bash'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, TSM_NO_USER_RC: '1' },
})
let termdLog = ''
termd.stdout.on('data', (d) => (termdLog += d))
termd.stderr.on('data', (d) => (termdLog += d))
// termd's end is noted from the start, however it comes: the cleanup below once waited on an exit event
// that had already fired for a termd a signal killed, and the check hung with no verdict (the house's
// read of 9f168ff, #22).
let termdEnd: { code: number | null; signal: NodeJS.Signals | null } | null = null
termd.once('exit', (code, signal) => (termdEnd = { code, signal }))
// The daemon's own pid, from its health answer: `node` on PATH may be a version manager's shim that
// runs the daemon as a child of its own, and a signal to the shim leaves the daemon running.
let termdPid: number | null = null
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
// A check that hangs ends here with the termd log and a verdict, not at the CI job's limit half an hour later.
const DEADLINE_MS = 120_000
const deadline = setTimeout(() => {
  log(`FAIL: the check did not finish within ${DEADLINE_MS / 1000} s`)
  log(termdLog.slice(-2000))
  if (termdPid !== null && alive(termdPid)) process.kill(termdPid, 'SIGKILL')
  termd.kill('SIGKILL')
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}, DEADLINE_MS)
for (let i = 0; i < 100 && !termdEnd; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`)
    if (r.ok) {
      termdPid = ((await r.json()) as { pid: number }).pid
      break
    }
  } catch {}
  await sleep(100)
}
log('termd on', port, 'pid', termdPid)

const SESSION = `br${process.pid}`
const wake = { wake: [['terminal:run-finished'], ['terminal:run-lost'], ['terminal:session-exited'], ['terminal:needs-input']], hold: [['terminal:output'], ['terminal:screen']] }
const gate = new WakeGate(wake)
const deliveries: any[] = []
const hostLog: string[] = []
const cfg: any = {
  transport: { url: `ws://127.0.0.1:${port}/?resultText=transcript`, token: 'ta' },
  grant: ['tools', 'pushEvents', 'channels.register', 'channels.lifecycle', 'channels.incoming', 'channels.publish', 'contextHooks.beforeInference.inject.beforeUser'],
  enableFeatureSets: ['terminal.core', 'terminal.live', 'terminal.channels', 'terminal.annotate', 'terminal.presence'],
  toolPrefix: 'terminal',
  wake,
  reconnect: true,
  reconnectIntervalMs: 300,
}
const h = new McplServerHandle('terminal', cfg, {
  deliver: (m: any) => deliveries.push(m),
  toolsChanged: () => {},
  log: (line: string) => hostLog.push(line),
})
const obsDeliveries: any[] = []
const observer = new McplServerHandle('terminal', { ...cfg, transport: { ...cfg.transport, token: 'tb' } }, { deliver: (m: any) => obsDeliveries.push(m), toolsChanged: () => {}, log: () => {} })

const call = async (name: string, args: any) => {
  const r: any = await h.callTool(name, args)
  return { text: (r.content ?? []).map((c: any) => c.text).join('\n'), structured: r.structuredContent, isError: r.isError }
}
let failures = 0
const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn()
    log('PASS', name)
  } catch (e) {
    failures++
    log('FAIL', name, '\n  ', (e as Error).message)
  }
}
const waitFor = async (pred: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) fail(`timed out: ${what}`)
    await sleep(50)
  }
}
const completions = (runId: string) => deliveries.filter((d) => d.text.includes(runId) && /→ exit/.test(d.text))

try {
  h.start()
  observer.start()
  await h.firstAttempt
  await observer.firstAttempt

  await check('connected with the shipped selection: the ten core tools', async () => {
    const names = h.tools.map((t: any) => t.name).sort()
    if (names.length !== 10 || !names.includes('run') || !names.includes('input') || !names.includes('session_declare_shell')) fail(`tools: ${names.join(',')}`)
  })

  const opened = await call('session_open', { session: SESSION, visibility: 'shared', cwd: tmp })
  if (opened.isError) fail(opened.text)
  await sleep(200)
  await observer.openChannel(`terminal:${SESSION}`)

  // The Run ends when this file appears in the session's cwd, and the check creates it once the
  // reconnect has been shown: a Run that slept 1.5 s raced the reconnect's own waits (3 s, then
  // 5 s), so a correct reconnect slower than that failed the check on a slow runner (the house's
  // read, #22 comment 6269721389). The command stays short: the completion head shows 100 characters.
  const released = path.join(tmp, 'reconnected')
  const COMMAND = 'until [ -e reconnected ]; do sleep 0.1; done; echo bridge-output'
  let runId = ''
  await check('start work, receive a run id, stop waiting', async () => {
    const r = await call('run', { session: SESSION, command: COMMAND, wait: 100 })
    if (r.structured?.state !== 'running') fail(r.text)
    runId = r.structured.runId
  })

  await check('disconnect and reconnect while it runs', async () => {
    // The drop is shown, not assumed: the handle notices its link close, comes back ready on a connection
    // it made later, and the Run is still in flight (the house's read of 9f168ff, #22).
    const was = h.connectedAt as number
    const logged = hostLog.length
    ;(h as any).conn?.close?.()
    await waitFor(() => hostLog.slice(logged).some((l) => /connection closed/.test(l)), 3000, 'the handle noticing the close')
    await waitFor(() => h.status === 'ready' && (h.connectedAt as number | null) !== null && (h.connectedAt as number) > was, 5000, 'reconnected on a new connection')
    const st = await call('await', { runId, wait: 0 })
    if (st.structured?.state !== 'running') fail(`the Run across the drop: ${st.text}`)
  })
  // Shown or failed, the Run is released now, so the checks after this one see it end. A completion
  // that falls inside the disconnect is not staged here: mcpl-lane.spec stages it in mcpl-8 (the
  // connection drops while a completion settles, and the new one gets it once) and in the
  // channels-only host's reconnect (a completion nothing could carry while the host was away,
  // delivered when the new connection opens the channel).
  fs.writeFileSync(released, '')

  let firstCompletionAt = 0
  await check('one useful completion notification, and it wakes the session', async () => {
    await waitFor(() => deliveries.some((d) => d.text.includes(runId)), 8000, 'completion delivery')
    firstCompletionAt = Date.now()
    const mine = completions(runId)
    if (mine.length !== 1) fail(`deliveries for the run: ${mine.length}`)
    const d = mine[0]
    if (!/bridge-output/.test(d.text)) fail(d.text)
    if (!d.text.startsWith(`[terminal] ${SESSION}: \`${COMMAND}\` → exit 0`)) fail(`head: ${d.text.split('\n')[0]}`)
    if (!String(d.meta.tags ?? '').split(' ').includes('terminal:run-finished')) fail(`tags reaching the bridge: ${d.meta.tags}`)
    if (gate.decide(d) !== 'wake') fail('a completion must wake the session by rule')
    if (gate.decide({ ...d, meta: { ...d.meta, tags: 'terminal:output terminal:running' } }) !== 'hold') fail('a digest must be held')
  })

  await check('recover retained output and the correct outcome by id', async () => {
    const w = await call('await', { runId })
    if (w.structured?.state !== 'exited' || w.structured?.exit !== 0) fail(w.text)
    const rd = await call('read', { session: SESSION, runId })
    if (!/bridge-output/.test(rd.text)) fail(rd.text)
  })

  await check('the observer saw it without taking the seat', async () => {
    await waitFor(() => obsDeliveries.some((d) => d.text.includes(runId)), 3000, 'observer delivery')
    const list = await call('session_list', {})
    const me = list.structured.sessions.find((s: any) => s.id === SESSION)
    if (me.controller === 'agent:observer@test') fail('observer holds the seat')
  })

  await check('mcpl_send (publish) records a note and never types', async () => {
    await h.openChannel(`terminal:${SESSION}`)
    const before = deliveries.length
    // Recorded is shown twice over: termd's answer names the note, and the observer, with the channel
    // open, receives it (the house's read of 9f168ff, #22).
    const answer = (await h.publish(`terminal:${SESSION}`, 'echo typed-by-publish')) as { delivered?: boolean; messageId?: string } | undefined
    if (answer?.delivered !== true || typeof answer.messageId !== 'string') fail(`publish answered ${JSON.stringify(answer)}`)
    await waitFor(() => obsDeliveries.some((d) => /typed-by-publish/.test(d.text)), 3000, 'the observer receiving the note')
    // The point where typing could have happened is shown, not slept past: the terminal takes input in
    // order, so a command run after the note reached termd, whose output the screen then shows, comes
    // after anything the publish had typed (the house's read, #22 comment 6274806357).
    const marker = await call('run', { session: SESSION, command: 'echo after-the-note', wait: 5000 })
    if (marker.structured?.state !== 'exited' || marker.structured?.exit !== 0) fail(`the marker command after the note: ${marker.text}`)
    const screen = await call('screen', { session: SESSION })
    // The screen must be the session's: a failed read, with no text to match, is no evidence.
    if (screen.isError) fail(`screen: ${screen.text}`)
    if (!/bridge-output/.test(screen.text)) fail(`the screen does not show the session's output:\n${screen.text}`)
    if (!/after-the-note/.test(screen.text)) fail(`the screen does not show the marker command run after the note:\n${screen.text}`)
    if (/typed-by-publish/.test(screen.text)) fail(`typed into the shell:\n${screen.text}`)
    const echoes = deliveries.slice(before).filter((d) => /typed-by-publish/.test(d.text))
    if (echoes.length) fail('a note came back as a delivery (loop risk)')
  })

  await check('presence through the bridge hook names the session', async () => {
    const inj = await h.beforeInference('hello', 'inf-1', 'conv', 1)
    const text = JSON.stringify(inj)
    if (!text.includes('[terminal]') || !text.includes(SESSION)) fail(text)
  })

  await check('still one completion for the Run two seconds on: nothing re-delivered after the reconnect', async () => {
    // Counted right after the first arrived, a late duplicate could not fail the check.
    await sleep(Math.max(0, firstCompletionAt + 2000 - Date.now()))
    const mine = completions(runId)
    if (mine.length !== 1) fail(`deliveries for the run: ${mine.length}`)
  })
} finally {
  await call('session_close', { session: SESSION, force: true }).catch(() => undefined)
  h.close()
  observer.close()
  // Wait for termd to exit before this process does: an orphaned termd whose stderr pipe
  // closed under it never finished shutting down (tsg-5). SIGKILL after 5 s. The daemon is
  // addressed by its own pid where the health answer gave one, else as the child.
  if (termdEnd) {
    const end = termdEnd as { code: number | null; signal: NodeJS.Signals | null }
    log(`termd ended before the cleanup: ${end.signal ?? `code ${end.code}`}`)
  }
  const own = termdPid === null || termdPid === termd.pid
  const stopped = () => (own ? termdEnd !== null : !alive(termdPid as number))
  const stop = async (signal: NodeJS.Signals, graceMs: number) => {
    if (stopped()) return true
    try {
      if (own) termd.kill(signal)
      else process.kill(termdPid as number, signal)
    } catch {}
    for (const end = Date.now() + graceMs; !stopped() && Date.now() < end; ) await sleep(100)
    return stopped()
  }
  if (!(await stop('SIGTERM', 5000))) {
    log('termd did not exit within 5 s of SIGTERM; killing it')
    await stop('SIGKILL', 2000)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  clearTimeout(deadline)
}
if (failures) log(termdLog.slice(-2000))
log(failures ? `${failures} FAILED` : 'ALL PASSED')
process.exit(failures ? 1 : 0)
