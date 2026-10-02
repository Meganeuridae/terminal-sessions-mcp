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

const BRIDGE = process.env.MCPL_BRIDGE ?? path.resolve(import.meta.dir, '../../../mcpl-cc-bridge/bridge/plugins/mcpl-bridge/src')
if (!fs.existsSync(path.join(BRIDGE, 'mcpl-host.ts'))) {
  console.log(`skip: mcpl-cc-bridge not found at ${BRIDGE} (set MCPL_BRIDGE)`)
  process.exit(0)
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
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break
  } catch {}
  await sleep(100)
}
log('termd on', port)

const SESSION = `br${process.pid}`
const wake = { wake: [['terminal:run-finished'], ['terminal:run-lost'], ['terminal:session-exited'], ['terminal:needs-input']], hold: [['terminal:output'], ['terminal:screen']] }
const gate = new WakeGate(wake)
const deliveries: any[] = []
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
  log: () => {},
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

try {
  h.start()
  observer.start()
  await h.firstAttempt
  await observer.firstAttempt

  await check('connected with the shipped selection: nine core tools', async () => {
    const names = h.tools.map((t: any) => t.name).sort()
    if (names.length !== 9 || !names.includes('run') || !names.includes('input')) fail(`tools: ${names.join(',')}`)
  })

  const opened = await call('session_open', { session: SESSION, visibility: 'shared' })
  if (opened.isError) fail(opened.text)
  await sleep(200)
  await observer.openChannel(`terminal:${SESSION}`)

  let runId = ''
  await check('start work, receive a run id, stop waiting', async () => {
    const r = await call('run', { session: SESSION, command: 'sleep 1.5; echo bridge-output', wait: 100 })
    if (r.structured?.state !== 'running') fail(r.text)
    runId = r.structured.runId
  })

  await check('disconnect and reconnect while it runs', async () => {
    ;(h as any).conn?.close?.()
    await sleep(100)
    await waitFor(() => h.status === 'ready', 5000, 'reconnected')
  })

  await check('one useful completion notification, and it wakes the session', async () => {
    await waitFor(() => deliveries.some((d) => d.text.includes(runId)), 8000, 'completion delivery')
    const mine = deliveries.filter((d) => d.text.includes(runId) && /→ exit/.test(d.text))
    if (mine.length !== 1) fail(`deliveries for the run: ${mine.length}`)
    const d = mine[0]
    if (!/bridge-output/.test(d.text)) fail(d.text)
    if (!d.text.startsWith(`[terminal] ${SESSION}: \`sleep 1.5; echo bridge-output\` → exit 0`)) fail(`head: ${d.text.split('\n')[0]}`)
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
    await h.publish(`terminal:${SESSION}`, 'echo typed-by-publish')
    await sleep(1200)
    const screen = await call('screen', { session: SESSION })
    if (/typed-by-publish/.test(screen.text)) fail(`typed into the shell:\n${screen.text}`)
    const echoes = deliveries.slice(before).filter((d) => /typed-by-publish/.test(d.text))
    if (echoes.length) fail('a note came back as a delivery (loop risk)')
  })

  await check('presence through the bridge hook', async () => {
    const inj = await h.beforeInference('hello', 'inf-1', 'conv', 1)
    const text = JSON.stringify(inj)
    if (!text.includes(`[terminal] ${SESSION}`) && !text.includes('idle, nothing new')) fail(text)
  })
} finally {
  await call('session_close', { session: SESSION, force: true }).catch(() => undefined)
  h.close()
  observer.close()
  // Wait for termd to exit before this process does: an orphaned termd whose stderr pipe
  // closed under it never finished shutting down (tsg-5). SIGKILL after 5 s.
  const exited = new Promise((resolve) => (termd.exitCode !== null ? resolve(undefined) : termd.once('exit', resolve)))
  termd.kill('SIGTERM')
  if (!(await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]))) {
    log('termd did not exit within 5 s of SIGTERM; killing it')
    termd.kill('SIGKILL')
    await exited
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}
if (failures) log(termdLog.slice(-2000))
log(failures ? `${failures} FAILED` : 'ALL PASSED')
process.exit(failures ? 1 : 0)
