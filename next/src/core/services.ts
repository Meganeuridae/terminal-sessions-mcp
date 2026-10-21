/**
 * Services (§8.3): a Run with readiness and health expectations. Status is
 * `starting → ready | running | unhealthy | exited | lost`. `ready` is asserted
 * only by probe results (G9); without a readiness probe a service that stays
 * alive through the liveness window is `running`, never `ready`. `unhealthy`
 * comes from a failed probe or a fail-pattern line, `exited` only from an
 * observed end of the Run, and `lost` when the Run's end was not observed (its
 * process may still be alive) — never from the liveness of the enclosing shell.
 *
 * Precedence (m2-15): a fail-pattern verdict beats health checks. `health.tcp`
 * clears only an `unhealthy` that a health check caused; a fail-pattern
 * `unhealthy` stands until a later line matches `ready.pattern` again (the
 * service says it recovered) or the Run ends. A readiness timeout is cleared by
 * readiness itself.
 *
 * Every status *change* is a journal event, which is how hosts hear about it
 * (§10.2), and so is a change of what makes the service unhealthy (a readiness
 * timeout, then a fail line), since what clears the verdict changes with it.
 * Further fail-pattern lines while already unhealthy for that reason update the
 * evidence and a repeat count on the monitor, not the journal (m2-16).
 */
import { compileLinePattern, LineSplitter, type SplitLine } from './ansi.js';
import { headOnlyText, testBounded } from './regex.js';
import type { Journal } from './journal.js';
import { timerMs } from './clock.js';
import { describeSpec, hasReadinessProbe, LIVENESS_MS, tcpConnect, type Connect, type ServiceSpec, type TcpTarget } from './probes.js';
import type { EventOf, JournalEvent, OutputStream, Principal, RunInfo, Seq, ServiceStatus } from './types.js';

export type { ServiceStatus } from './types.js';

/** What made a service `unhealthy`: a fail-pattern line, a failed health check, or readiness that timed out. */
export type UnhealthyCause = 'fail-pattern' | 'health' | 'timeout';

export interface ServiceInfo {
  runId: string;
  name?: string;
  status: ServiceStatus;
  probe: string;
  owner: Principal;
  /** When the current status began. */
  since: number;
  /** The journal event that reported the current status. */
  seq?: Seq;
  evidence?: string;
  exit?: number;
  signal?: string;
  /** Why it is `unhealthy`. */
  cause?: UnhealthyCause;
  /** Fail-pattern lines seen in this unhealthy period after the first; `evidence` is the latest. */
  repeats?: number;
}

/** What a monitor needs from its session. */
export interface ServiceHost {
  readonly journal: Journal;
  run(runId: string): RunInfo;
  /** Cancel a Run (a live Session's `cancel`): used when a spec is refused after its Run was admitted. */
  cancel?(runId: string, principal: Principal): Promise<unknown>;
}

export interface ServiceDeps {
  connect?: Connect;
  /** Liveness window when no readiness probe is given (ms); default LIVENESS_MS. */
  livenessMs?: number;
  /** Quiet period before an unterminated line (a prompt) is matched (ms); see LineSplitter. */
  partialAfterMs?: number;
}

type Condition = 'pattern' | 'tcp' | 'alive';

/** One reading of a service Run's output (ServiceMonitor.lines and .pipes): its splitter, the seq it was last fed, and the pipe it reads alone. */
interface Reading {
  splitter: LineSplitter;
  seq: Seq;
  pipe?: OutputStream;
}

/** TCP poll interval while starting (ms). */
const TCP_POLL_MS = 250;

const ended = (s: ServiceStatus) => s === 'exited' || s === 'lost';

export class ServiceMonitor {
  private statusValue: ServiceStatus = 'starting';
  private sinceTs = Date.now();
  private statusSeq: Seq | undefined;
  private evidenceText: string | undefined;
  private cause: UnhealthyCause | undefined;
  private repeats = 0;
  private exitInfo: { exit?: number; signal?: string } = {};
  private readonly met = new Set<Condition>();
  private readonly needed = new Set<Condition>();
  private readonly readyRe: RegExp | undefined;
  private readonly failRe: RegExp | undefined;
  /**
   * The Run's lines as a read shows them (§6 rule 6): the pty, or a process Run's stdout and stderr as one source, as
   * search and watches read them, so a pattern written from a line someone read or watched matches that line.
   */
  private lines: Reading | undefined;
  /**
   * Each pipe's lines as it wrote them (m2-21): a ready line on stdout that stderr's output broke in two (`Server
   * listen`, a stderr line, then `ing on 8080`) still passes, and a fail line at the start of stderr's output is at
   * a line start, whatever stdout held. Bounded as the source's are: MAX_LINE, and a quiet prompt offered.
   */
  private readonly pipes = new Map<OutputStream, Reading>();
  /**
   * The lines offered at the latest output event, by text, and whether one matched: a line both readings read alike
   * at one event is matched once, so its evidence and a fail line's count name one line.
   */
  private offered: { seq: Seq; lines: Map<string, boolean> } = { seq: 0, lines: new Map() };
  /** A fail-pattern line was seen and no ready-pattern line since. */
  private failed = false;
  private started = false;
  private healthStarted = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly waiters = new Set<() => void>();
  private readonly off: () => void;
  private readonly connect: Connect;
  private readonly livenessMs: number;
  private readonly partialAfterMs: number | undefined;
  private readonly probeText: string;
  private disposed = false;
  private readyEvidence: string[] = [];

  /** Throws invalid_argument for a pattern `validateServiceSpec` would refuse; check the spec before admitting the Run. */
  constructor(
    private readonly host: ServiceHost,
    readonly runId: string,
    readonly spec: ServiceSpec,
    readonly owner: Principal,
    readonly name: string | undefined,
    deps: ServiceDeps = {},
  ) {
    this.connect = deps.connect ?? tcpConnect;
    this.livenessMs = deps.livenessMs ?? LIVENESS_MS;
    this.partialAfterMs = deps.partialAfterMs;
    this.probeText = describeSpec(spec, this.livenessMs);
    const r = spec.ready ?? {};
    // Compile first: a refused pattern throws before anything is subscribed or journaled.
    if (r.pattern !== undefined) this.readyRe = compileLinePattern(r.pattern);
    if (spec.fail?.pattern !== undefined) this.failRe = compileLinePattern(spec.fail.pattern);
    if (r.pattern !== undefined) this.needed.add('pattern');
    if (r.tcp) this.needed.add('tcp');
    if (r.exitWithinMs !== undefined) this.needed.add('alive');

    this.off = host.journal.subscribe((ev) => this.onEvent(ev));
    this.statusSeq = this.journal('starting');

    // Output that arrived before the monitor existed (a process Run starts at admission), read to the end.
    const run = host.run(runId);
    for (const page of host.journal.pages(run.seq.admit - 1)) for (const ev of page.events) this.onEvent(ev);
    if (this.disposed || ended(this.statusValue)) return;
    if (run.state === 'running') this.onStarted();

    if (r.tcp) this.pollTcp(r.tcp, TCP_POLL_MS);
    // A timeout bounds readiness; without a readiness probe there is none to wait for.
    if (r.timeoutMs !== undefined && this.needed.size) {
      this.after(r.timeoutMs, () => {
        if (this.statusValue === 'starting') this.setStatus('unhealthy', `not ready within ${r.timeoutMs}ms (${this.missing()})`, 'timeout');
      });
    }
  }

  get status(): ServiceStatus {
    return this.statusValue;
  }

  info(): ServiceInfo {
    const i: ServiceInfo = { runId: this.runId, status: this.statusValue, probe: this.probeText, owner: this.owner, since: this.sinceTs };
    if (this.name !== undefined) i.name = this.name;
    if (this.statusSeq !== undefined) i.seq = this.statusSeq;
    if (this.evidenceText !== undefined) i.evidence = this.evidenceText;
    if (this.exitInfo.exit !== undefined) i.exit = this.exitInfo.exit;
    if (this.exitInfo.signal !== undefined) i.signal = this.exitInfo.signal;
    if (this.statusValue === 'unhealthy' && this.cause !== undefined) i.cause = this.cause;
    if (this.statusValue === 'unhealthy' && this.repeats > 0) i.repeats = this.repeats;
    return i;
  }

  /** Resolve once the status has left `starting`, or after `ms`. */
  waitSettled(ms: number): Promise<ServiceInfo> {
    if (this.statusValue !== 'starting' || ms <= 0 || this.disposed) return Promise.resolve(this.info());
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.info());
      };
      const timer = setTimeout(done, timerMs(ms));
      this.waiters.add(done);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.stopTimers();
    for (const w of [...this.waiters]) w();
  }

  // ───────────── observation ─────────────

  private onEvent(ev: JournalEvent): void {
    if (this.disposed || ended(this.statusValue)) return;
    if (ev.type === 'output' && ev.runId === this.runId) {
      // After readiness the ready pattern matters only as the answer to a fail line.
      if (!this.failRe && (!this.readyRe || this.met.has('pattern'))) return;
      // A pattern matches a line as a read shows it, or as its own pipe wrote it: the one source first, then the
      // pipe's, a line both read alike at one event matched once (the house's review of 4f4c067..a8b6f28, #22,
      // comment 6323055715, question 3).
      for (const line of this.feed(this.source(), ev)) this.once(ev.seq, line);
      if (ev.stream === 'pty') return;
      for (const line of this.feed(this.pipe(ev.stream), ev)) this.once(ev.seq, line);
    } else if (ev.type === 'run.start' && ev.runId === this.runId) {
      this.onStarted();
    } else if (ev.type === 'run.end' && ev.runId === this.runId) {
      if (ev.exit !== undefined) this.exitInfo.exit = ev.exit;
      if (ev.signal) this.exitInfo.signal = ev.signal;
      if (ev.state === 'lost') {
        // G3/G9: the end was not observed (the shell went away, the daemon restarted);
        // the process may still be running and holding its port.
        this.setStatus('lost', `Run outcome unknown (${ev.reason ?? 'lost'}): its process may still be running`);
      } else {
        this.setStatus('exited', ev.state === 'cancelled' ? `cancelled${ev.signal ? ` (${ev.signal})` : ''}` : ev.signal ? `killed by ${ev.signal}` : `exit ${ev.exit ?? '?'}`);
      }
    }
  }

  /** Feed one reading an output event: the one source takes the event's stream as the source of what it reads. */
  private feed(r: Reading, ev: EventOf<'output'>): SplitLine[] {
    r.seq = ev.seq;
    return r.splitter.feed(ev.data, r.pipe === undefined ? ev.stream : undefined);
  }

  /** A line one reading offered at `seq`: matched unless the other reading offered it alike there, and then as that was. */
  private once(seq: Seq, line: SplitLine): boolean {
    if (seq !== this.offered.seq) this.offered = { seq, lines: new Map() };
    const had = this.offered.lines.get(line.text);
    if (had !== undefined) {
      this.offered.lines.delete(line.text);
      return had;
    }
    const matched = this.onLine(line);
    this.offered.lines.set(line.text, matched);
    return matched;
  }

  /** A reading of the Run's output, and the seq it was last fed: a quiet prompt it offers is one at that event. */
  private reading(pipe?: OutputStream): Reading {
    const r: Reading = { splitter: undefined as never, seq: 0, ...(pipe !== undefined ? { pipe } : {}) };
    const opts: ConstructorParameters<typeof LineSplitter>[0] = { onPartial: (line) => this.once(r.seq, line) };
    if (this.partialAfterMs !== undefined) opts.partialAfterMs = this.partialAfterMs;
    r.splitter = new LineSplitter(opts);
    return r;
  }

  private source(): Reading {
    return (this.lines ??= this.reading());
  }

  private pipe(stream: OutputStream): Reading {
    let r = this.pipes.get(stream);
    if (!r) this.pipes.set(stream, (r = this.reading(stream)));
    return r;
  }

  /**
   * One line of the Run's output, as a read shows it or as its own pipe wrote it; true when a pattern matched it. A fail
   * match wins over a ready match on the same line. The evidence names the line, whichever reading it is: m2-21's says
   * `Server listening on 8080`.
   */
  private onLine(line: SplitLine): boolean {
    if (this.disposed || ended(this.statusValue)) return false;
    // Matched on the line's head within the pattern's match window, as watches and search are
    // (the house's read of ed4ecac, #22: a long pattern on a 64 KiB line held the thread for seconds),
    // and on the head the splitter kept of a line longer than MAX_LINE; the evidence says when only
    // the head was looked at.
    const text = line.text;
    const evidenceOf = (clipped: boolean) => (clipped || line.cut ? `${text.trim()} (${headOnlyText()})` : text.trim());
    const fail = this.failRe ? testBounded(this.failRe, text) : undefined;
    if (fail?.matched) {
      this.onFail(evidenceOf(fail.clipped));
      return true;
    }
    const ready = this.readyRe ? testBounded(this.readyRe, text) : undefined;
    if (ready?.matched) {
      this.onReadyLine(evidenceOf(ready.clipped));
      return true;
    }
    return false;
  }

  private onFail(evidence: string): void {
    this.failed = true;
    if (this.statusValue === 'unhealthy' && this.cause === 'fail-pattern') {
      // Same verdict, new evidence: counted, not journaled again (m2-16).
      this.repeats++;
      this.evidenceText = evidence;
      return;
    }
    if (this.statusValue === 'unhealthy') {
      // Already unhealthy for another cause: the fail pattern now holds the verdict, and the
      // journal says so, since a timeout readiness would have cleared now needs a ready line
      // (the house's read of 3eade8a, #22).
      this.cause = 'fail-pattern';
      this.evidenceText = evidence;
      this.repeats = 0;
      this.statusSeq = this.journal('unhealthy', evidence);
      return;
    }
    this.setStatus('unhealthy', evidence, 'fail-pattern');
  }

  private onReadyLine(evidence: string): void {
    const recovering = this.failed;
    this.failed = false;
    if (!this.met.has('pattern')) {
      this.condition('pattern', evidence);
      return;
    }
    // A ready line after a fail line: the service says it recovered (m2-15), and its health
    // checks start if the fail line came before readiness did (the house's read of 3eade8a, #22).
    if (recovering && this.allMet() && this.statusValue === 'unhealthy' && this.cause === 'fail-pattern') {
      this.setStatus(this.healthyStatus(), `${evidence} (ready pattern matched again after the fail line)`);
      this.startHealth();
    }
  }

  private onStarted(): void {
    if (this.started) return;
    this.started = true;
    const r = this.spec.ready ?? {};
    if (r.exitWithinMs !== undefined) this.after(r.exitWithinMs, () => this.condition('alive', `still running after ${r.exitWithinMs}ms`));
    if (!hasReadinessProbe(this.spec)) {
      // No probe can assert `ready` (G9): after the liveness window it is `running`.
      this.after(this.livenessMs, () => {
        if (this.statusValue !== 'starting') return;
        this.setStatus('running', `alive after ${this.livenessMs}ms; no readiness probe was given, so readiness is not known`);
        this.startHealth();
      });
    }
  }

  private condition(c: Condition, evidence: string): void {
    if (this.met.has(c) || !this.needed.has(c) || ended(this.statusValue)) return;
    this.met.add(c);
    this.readyEvidence.push(evidence);
    // A fail line seen and not answered by a ready line keeps the verdict (m2-15).
    if (this.allMet() && !this.failed && this.statusValue !== 'ready') {
      this.setStatus('ready', this.readyEvidence.join('; '));
      this.startHealth();
    }
  }

  private allMet(): boolean {
    return [...this.needed].every((n) => this.met.has(n));
  }

  /** What the service is when nothing is wrong: `ready` if a probe said so, else `running`. */
  private healthyStatus(): ServiceStatus {
    return this.needed.size ? 'ready' : 'running';
  }

  private missing(): string {
    return [...this.needed].filter((n) => !this.met.has(n)).join(', ') || 'nothing';
  }

  private pollTcp(target: TcpTarget, every: number): void {
    const tick = async () => {
      if (this.disposed || this.met.has('tcp') || ended(this.statusValue)) return;
      const ok = await this.connect(target, Math.max(200, every * 2));
      if (this.disposed || ended(this.statusValue)) return;
      if (ok) this.condition('tcp', `port ${target.port} accepting`);
      else this.after(every, tick);
    };
    void tick();
  }

  private startHealth(): void {
    const h = this.spec.health;
    if (!h?.tcp || this.healthStarted) return;
    this.healthStarted = true;
    const target = h.tcp;
    const every = h.intervalMs ?? 5000;
    const tick = async () => {
      if (this.disposed || ended(this.statusValue)) return;
      const ok = await this.connect(target, Math.min(2000, every));
      if (this.disposed || ended(this.statusValue)) return;
      const status = this.statusValue;
      if (!ok && (status === 'ready' || status === 'running')) this.setStatus('unhealthy', `port ${target.port} not accepting`, 'health');
      // Only an unhealthy the health check caused is the health check's to clear (m2-15).
      else if (ok && status === 'unhealthy' && this.cause === 'health') this.setStatus(this.healthyStatus(), `port ${target.port} accepting again`);
      this.after(every, tick);
    };
    this.after(every, tick);
  }

  private after(ms: number, fn: () => void): void {
    if (this.disposed) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, timerMs(ms));
    this.timers.add(t);
  }

  private stopTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.lines?.splitter.dispose();
    for (const r of this.pipes.values()) r.splitter.dispose();
  }

  private setStatus(status: ServiceStatus, evidence: string, cause?: UnhealthyCause): void {
    if (ended(this.statusValue) || this.statusValue === status) return;
    this.statusValue = status;
    this.evidenceText = evidence;
    this.cause = status === 'unhealthy' ? cause : undefined;
    this.repeats = 0;
    this.sinceTs = Date.now();
    this.statusSeq = this.journal(status, evidence);
    if (ended(status)) {
      this.stopTimers();
      this.off();
    }
    if (status !== 'starting') for (const w of [...this.waiters]) w();
  }

  private journal(status: ServiceStatus, evidence?: string): Seq {
    const ev: Parameters<Journal['append']>[0] = { type: 'service', runId: this.runId, status, probe: this.probeText, principal: this.owner };
    if (this.name !== undefined) ev.name = this.name;
    if (evidence !== undefined) ev.evidence = evidence;
    if (this.exitInfo.exit !== undefined && status === 'exited') ev.exit = this.exitInfo.exit;
    return this.host.journal.append(ev).seq;
  }
}

/** A session's services, keyed by runId. */
export class ServiceManager {
  private readonly monitors = new Map<string, ServiceMonitor>();

  constructor(private readonly host: ServiceHost) {}

  /**
   * Attach a monitor to an admitted Run. Check the spec with `validateServiceSpec`
   * before admitting: a pattern refused here (invalid_argument) cancels the Run it
   * was meant for, so a refused `start` never leaves a process behind.
   */
  watch(runId: string, spec: ServiceSpec, owner: Principal, name?: string): ServiceMonitor {
    this.monitors.get(runId)?.dispose();
    let m: ServiceMonitor;
    try {
      m = new ServiceMonitor(this.host, runId, spec, owner, name);
    } catch (e) {
      this.host.cancel?.(runId, owner).catch(() => undefined);
      throw e;
    }
    this.monitors.set(runId, m);
    return m;
  }

  get(runId: string): ServiceMonitor | undefined {
    return this.monitors.get(runId);
  }

  list(): ServiceInfo[] {
    return [...this.monitors.values()].map((m) => m.info());
  }

  dispose(): void {
    for (const m of this.monitors.values()) m.dispose();
    this.monitors.clear();
  }
}
