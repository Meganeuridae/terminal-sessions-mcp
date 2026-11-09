#!/usr/bin/env bun
// Acceptance against Claude Code's MCPL host: mcpl-cc-bridge's own McplServerHandle and WakeGate
// (the classes the plugin runs), under bun, launching tsm-relay over stdio as next/config/mcpl-bridge.json does.
//
//   MCPL_BRIDGE=/path/to/mcpl-cc-bridge/plugins/mcpl-bridge/src bun next/acceptance/bridge.ts   (after npm run build:next)
//
// It checks the central promise through the bridge: the tools, a command that outlives its call
// delivered once with the wake gate deciding to wake, and after the daemon goes away the bridge's
// reconnect reaching a new daemon that runs nothing behind the agent's back.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const BRIDGE = process.env.MCPL_BRIDGE ?? ''
if (!fs.existsSync(path.join(BRIDGE, 'mcpl-host.ts'))) {
  console.log(`${process.env.ACCEPTANCE_REQUIRED === '1' ? 'FAIL' : 'skip'}: mcpl-cc-bridge not found at ${BRIDGE || '(MCPL_BRIDGE unset)'}`)
  process.exit(process.env.ACCEPTANCE_REQUIRED === '1' ? 1 : 0)
}
const { McplServerHandle } = await import(path.join(BRIDGE, 'mcpl-host.ts'))
const { WakeGate } = await import(path.join(BRIDGE, 'wake.ts'))
const DIST = path.resolve(import.meta.dir, '../dist/src')

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => performance.now()
const fail = (msg: string): never => {
  throw new Error(msg)
}
const waitFor = async (pred: () => boolean, ms: number, what: string) => {
  const end = now() + ms
  while (!pred()) {
    if (now() > end) fail(`timed out: ${what}`)
    await sleep(50)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-accept-bridge-'))
const socket = path.join(tmp, 'run', 'daemon.sock')
const node = process.env.NODE_BIN ?? 'node'
const stopDaemon = () => {
  try {
    execFileSync(node, [path.join(DIST, 'cli/tsm.js'), '--socket', socket, 'daemon', 'stop'], { stdio: 'pipe', timeout: 20_000 })
  } catch {}
}
const deadline = setTimeout(() => {
  log('FAIL: the check did not finish within 180 s')
  stopDaemon()
  process.exit(1)
}, 180_000)

const shipped = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../config/mcpl-bridge.json'), 'utf8')).servers.terminal
const wake = shipped.wake
const gate = new WakeGate(wake)
const deliveries: any[] = []
const hostLog: string[] = []
const h = new McplServerHandle(
  'terminal',
  {
    ...shipped,
    transport: { command: node, args: [path.join(DIST, 'relay.js'), '--socket', socket, ...shipped.transport.args] },
    reconnectIntervalMs: 300,
  } as any,
  { deliver: (m: any) => deliveries.push(m), toolsChanged: () => {}, log: (line: string) => hostLog.push(line) },
)
const call = async (name: string, args: any) => {
  const r: any = await h.callTool(name, args)
  return { text: (r.content ?? []).map((c: any) => c.text).join('\n'), isError: r.isError === true }
}
let failures = 0
const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn()
    log('PASS', name)
  } catch (e) {
    failures++
    log('FAIL', name, '\n  ', (e as Error).message, '\n  host log:', hostLog.slice(-8).join('\n    '))
  }
}

try {
  h.start()
  await h.firstAttempt
  await check('the bridge reaches the daemon through the relay, with the tools', async () => {
    await waitFor(() => h.status === 'ready', 30_000, 'the handle ready')
    const names = h.tools.map((t: any) => t.name)
    for (const t of ['open', 'run', 'send', 'look', 'read', 'stop', 'integrate', 'list', 'close']) if (!names.some((n: string) => n.endsWith(t))) fail(`${t} in ${names.join(', ')}`)
  })

  const released = path.join(tmp, 'released')
  await check('a command that outlives its call is delivered once, and the wake gate wakes on it', async () => {
    const opened = await call('open', { name: 'main', cwd: tmp })
    if (opened.isError) fail(opened.text)
    const r = await call('run', { name: 'main', command: `until [ -e '${released.replace(/'/g, "'\\''")}' ]; do sleep 0.1; done; echo acceptance-out""put`, wait: 0 })
    if (!/still running/.test(r.text)) fail(r.text)
    fs.writeFileSync(released, '')
    const mine = () => deliveries.filter((d) => /acceptance-output/.test(d.text))
    await waitFor(() => mine().length > 0, 15_000, 'the end delivered')
    await sleep(500)
    if (mine().length !== 1) fail(`deliveries of the end: ${mine().length}`)
    if (!/\[main · command \d+ · exit 0 · /.test(mine()[0].text)) fail(`head: ${mine()[0].text.split('\n')[0]}`)
    if (gate.decide(mine()[0]) !== 'wake') fail('an end must wake the session by rule')
  })

  await check("when the daemon goes away the bridge reconnects to a new one, which runs nothing behind the agent's back", async () => {
    const was = h.connectedAt as number
    stopDaemon()
    await waitFor(() => h.status === 'ready' && (h.connectedAt as number | null) !== null && (h.connectedAt as number) > was, 30_000, 'reconnected through a new relay')
    const marker = path.join(tmp, 'SHOULD_NOT_EXIST')
    const again = await call('run', { name: 'main', command: `touch ${marker}` })
    if (!again.isError) fail(again.text)
    if (!/^No session named "main" is open in scope "claude", and none is opened for you\./.test(again.text)) fail(again.text)
    if (fs.existsSync(marker)) fail('it ran')
  })
} finally {
  clearTimeout(deadline)
  h.close()
  stopDaemon()
  fs.rmSync(tmp, { recursive: true, force: true })
}
log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
