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
import { compileLinePattern, LineSplitter, type Begun, type SplitLine } from './ansi.js';
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

/** A place in a Run's output (where a line began or ended: SplitLine.begun, .ended), as a key; the line's text when it has none. */
const placeOf = (p: Begun | undefined, line: SplitLine): string => (p ? `${p.at}:${p.offset}` : `?${line.text}`);

/** Lines in the order their ends came: by event, then by offset in it; a line with no end after those with one. */
const endOrder = (a: Begun | undefined, b: Begun | undefined): number => (a && b ? a.at - b.at || a.offset - b.offset : a ? -1 : b ? 1 : 0);

/** One reading of a service Run's output (ServiceMonitor.lines and .pipes): its splitter, and the pipe it reads alone. */
interface Reading {
  splitter: LineSplitter;
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
   * The quiet prompts tested, by where each began (placeOf), and whether one matched: a prompt and its twin, the
   * other reading's line that began at the same place, are one line, matched once. Kept while a reading holds the line
   * open (prunePrompts).
   */
  private readonly prompted = new Map<string, boolean>();
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
      // A pattern matches a line as a read shows it, or as its own pipe wrote it (the house's review of
      // 4f4c067..a8b6f28, #22, comment 6323055715, question 3). The two readings' lines that one line end completes
      // are one line, matched once, as its pipe wrote it first: told apart by their text, `FATAL: db crashed` on
      // stdout, a stderr `x` and stdout's LF were two lines, counted twice, the read's `FATAL: db crashedx` journaled
      // and the pipe's held as the evidence; told apart by where they began, stdout's `ERROR a`, then `ERROR b` and a
      // LF on stderr, counted stderr's line twice, once in the read's `ERROR aERROR b`. Every line end is one pipe's
      // and the read's alike, so it completes at most one line of each reading, and lines that one end does not
      // complete are other lines: m2-21's `Server listening on 8080`, stdout's own, ended by stdout's LF after the
      // read ended `Server listenwarn: deprecated` at stderr's.
      const read = this.feed(this.source(), ev);
      const own = ev.stream !== 'pty' ? this.feed(this.pipe(ev.stream), ev) : [];
      // The event's lines are taken in the order their ends came, the read's and the pipe's interleaved: handled the
      // read's first, stdout's `FATAL` ended by its LF after stderr's ended the read's `FATALx`, then stdout's `READY`,
      // left FATAL in force after READY (our review of the 73 commits through 4860d4c, PR #22).
      const twins = new Map(own.map((line) => [placeOf(line.ended, line), line]));
      const lines: SplitLine[][] = read.map((line) => {
        const twin = twins.get(placeOf(line.ended, line));
        if (!twin) return [line];
        twins.delete(placeOf(line.ended, line));
        return [twin, line];
      });
      for (const line of twins.values()) lines.push([line]);
      lines.sort((x, y) => endOrder(x[0]!.ended, y[0]!.ended));
      for (const texts of lines) this.onLines(texts);
      this.prunePrompts();
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

  /** Feed one reading an output event: the one source takes the event's stream as the source of what it reads; each line says where it began. */
  private feed(r: Reading, ev: EventOf<'output'>): SplitLine[] {
    return r.splitter.feed(ev.data, r.pipe === undefined ? ev.stream : undefined, ev.seq);
  }

  /**
   * A completed line, as one reading or both wrote it (`texts`, the pipe's first): matched unless it is a quiet prompt
   * already matched, whose reading spent it while the other's went on to complete it.
   */
  private onLines(texts: SplitLine[]): void {
    if (texts.some((line) => this.prompted.get(placeOf(line.begun, line)))) return;
    this.onLine(...texts);
  }

  /**
   * A quiet prompt `r` offered: tested together with its twin, the other reading's open line that began where it did,
   * both texts at once (the pipe's first), as a completed pair is, and matched once. Taken alone, the first offer's
   * verdict stood for its twin's different text: stderr's `Password: ` was never tested when the read's `Passxword: `
   * had failed. Told apart by the seq each reading was last fed, one prompt counted twice when the other pipe wrote in
   * between (our review of the 73 commits through 4860d4c, PR #22).
   */
  private once(r: Reading, line: SplitLine): boolean {
    const at = placeOf(line.begun, line);
    if (this.prompted.get(at)) return true;
    const twin = this.readings().find((o) => o !== r && placeOf(o.splitter.peek()?.begun, line) === at)?.splitter.peek();
    const matched = twin ? (r.pipe !== undefined ? this.onLine(line, twin) : this.onLine(twin, line)) : this.onLine(line);
    this.prompted.set(at, matched);
    return matched;
  }

  /** A prompt's entry goes once no reading holds its line open. */
  private prunePrompts(): void {
    if (this.prompted.size === 0) return;
    const open = new Set(this.readings().flatMap((o) => {
      const line = o.splitter.peek();
      return line?.begun ? [placeOf(line.begun, line)] : [];
    }));
    for (const at of this.prompted.keys()) if (!open.has(at)) this.prompted.delete(at);
  }

  private readings(): Reading[] {
    return [...(this.lines ? [this.lines] : []), ...this.pipes.values()];
  }

  /** A reading of the Run's output: a quiet prompt it offers is matched once with its twin's. */
  private reading(pipe?: OutputStream): Reading {
    const r: Reading = { splitter: undefined as never, ...(pipe !== undefined ? { pipe } : {}) };
    const opts: ConstructorParameters<typeof LineSplitter>[0] = { onPartial: (line) => this.once(r, line) };
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
   * One line of the Run's output, as a read shows it or as its own pipe wrote it, or as both (`texts`, the pipe's
   * first): two completed lines that one line end completes, or a quiet prompt and the other reading's open line that
   * began where it did; true when a pattern matched it. A fail match wins over a ready match on the same
   * line, in either reading; the evidence is the first reading that matched. It names the line, whichever reading it
   * is: m2-21's says `Server listening on 8080`.
   */
  private onLine(...texts: SplitLine[]): boolean {
    if (this.disposed || ended(this.statusValue)) return false;
    // Matched on the line's head within the pattern's match window, as watches and search are
    // (the house's read of ed4ecac, #22: a long pattern on a 64 KiB line held the thread for seconds),
    // and on the head the splitter kept of a line longer than MAX_LINE; the evidence says when only
    // the head was looked at.
    const evidenceOf = (line: SplitLine, clipped: boolean) => (clipped || line.cut ? `${line.text.trim()} (${headOnlyText()})` : line.text.trim());
    const first = (re: RegExp | undefined) => {
      if (!re) return undefined;
      for (const line of texts) {
        const t = testBounded(re, line.text);
        if (t.matched) return evidenceOf(line, t.clipped);
      }
      return undefined;
    };
    const fail = first(this.failRe);
    if (fail !== undefined) {
      this.onFail(fail);
      return true;
    }
    const ready = first(this.readyRe);
    if (ready !== undefined) {
      this.onReadyLine(ready);
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

  /**
   * Stop every timer, and let the readings go: an ended or disposed monitor keeps only what info() reports, where its
   * readings' open lines, each up to MAX_LINE of raw text, stayed for the session's life (our review of the 73
   * commits through 4860d4c, PR #22).
   */
  private stopTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const r of this.readings()) r.splitter.dispose();
    this.lines = undefined;
    this.pipes.clear();
    this.prompted.clear();
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
