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
 *
 * A pattern matches a line as a read shows it, a process Run's stdout and stderr as one source, or as its own pipe
 * wrote it (m2-21). A line both readings hold is one line, matched once, by two rules side by side:
 * - Completed lines pair by the line end that completes both, or by beginning at one place with the same text, the
 *   other pipe having added nothing to the line. A LF is one pipe's, so it completes at most one line of each reading:
 *   stdout's `ERROR a`, then `ERROR b` and a LF on stderr, then stdout's LF, are two lines, the read's `ERROR aERROR b`
 *   with stderr's `ERROR b`, and stdout's `ERROR a`, whose text is not the read's line begun there. stderr's
 *   `Password: `, stdout's LF, then stderr's LF are one line, the read's ended at stdout's LF and stderr's at its own.
 * - A quiet prompt pairs with the other readings' open lines that hold bytes of its own, all at once: the read's with
 *   every pipe's open line written to since the read's line began, begun inside it or before it, and a pipe's with the
 *   read's line begun no later than the pipe's last write, and through it with the other pipe's. So stdout's `server
 *   ready` left quiet, then stderr's `FATAL` left
 *   quiet, is one line, the FATAL counted once as it is when stderr's LF ends both, not twice (an independent read of
 *   the fixes for PR #22 comment 6357989601). It pairs too with the other reading's line that began where it did and
 *   already ended when the prompt is offered: stderr's `Password: ` that stdout's LF ended in the read counts once. So
 *   stdout's `ERROR a`, left quiet before its LF, is a prompt begun where the read's `ERROR aERROR b` began, and the
 *   first rule's two lines are one (the house's review of a8b6f28..4860d4c, #22, comment 6341260318, question 6).
 * Two verdicts, two finalities (the house's review of 4860d4c..bc4bc85, #22, comment 6357989601). A fail match is
 * final for its place: the rest of its line is not matched again, in either reading, so a fail is counted once per
 * line. A ready match is final for ready alone: the line's later text, and any line paired with it, the other
 * reading's twin, is still tested for fail, and ready is never journaled again for the line, so stdout's `server
 * ready`, left quiet, then ` FATAL` on the same line is unhealthy, where a ready that spent the line never saw the
 * FATAL. The cost is a ready prompt offered again as its line grows, tested for fail only. A line the other pipe ends
 * at a spent line's end is matched on its own (stdout's `ERROR a` matched quiet, then `ERROR b` and a LF on stderr,
 * are two matches).
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

/**
 * What a place in a Run's output, where a line began, has been judged so far: a fail is final, nothing begun there is
 * matched again; a ready leaves what the line holds past the match, and any line paired with it, to be tested for fail
 * alone (the house's review of 4860d4c..bc4bc85, #22, comment 6357989601).
 */
type Verdict = 'fail' | 'ready' | undefined;

/** The stronger of two verdicts on one place: a fail, else a ready, else none. */
const stronger = (a: Verdict, b: Verdict): Verdict => (a === 'fail' || b === 'fail' ? 'fail' : a ?? b);

/** A line the other reading may hold too (ServiceMonitor.prompted, .completed): where it began, its verdict so far, and a completed line's text. */
interface Twin {
  at: Begun | undefined;
  verdict: Verdict;
  text?: string;
}

/** Two places in a Run's output are one: the same event, and the same bytes into it. */
const samePlace = (a: Begun | undefined, b: Begun): boolean => a !== undefined && a.at === b.at && a.offset === b.offset;

/** Lines in the order their ends came: by event, then by offset in it; a line with no end after those with one. */
const endOrder = (a: Begun | undefined, b: Begun | undefined): number => (a && b ? a.at - b.at || a.offset - b.offset : a ? -1 : b ? 1 : 0);

/** One reading of a service Run's output (ServiceMonitor.lines and .pipes): its splitter, and the pipe it reads alone. */
interface Reading {
  splitter: LineSplitter;
  pipe?: OutputStream;
  /** The seq of the event last fed: a pipe's open line holds bytes of the read's when the pipe wrote since the read's line began (twins). */
  last?: number;
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
   * The quiet prompts tested, by where each began (placeOf), and their verdict so far: a prompt and its twin, the
   * other reading's line that began at the same place, are one line, a fail matched once on it and a ready leaving
   * the rest to fail. Kept while a reading holds the line open (pruneTwins).
   */
  private readonly prompted = new Map<string, Twin>();
  /**
   * The completed lines another reading still holds a line open beside, begun at the same place (placeOf), with their
   * verdict so far and their text: a quiet prompt that reading offers later is their twin, judged with them (once),
   * and a line it completes with the same text is the same line (sameCompleted). Kept while a reading holds the line
   * open (pruneTwins), so at most one a reading.
   */
  private readonly completed = new Map<string, Twin>();
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
      for (const texts of lines) {
        // A line the other reading completed already, begun at its place with the same text, is that line, matched
        // once: stderr's `Password: `, then stdout's LF and stderr's, counted twice, the read's line ended at stdout's
        // LF and stderr's at its own, where a quiet between them counted it once (the house's review of
        // a8b6f28..4860d4c, #22, comment 6341260318, question 6).
        const fresh = this.completed.size ? texts.filter((line) => !this.sameCompleted(line)) : texts;
        const verdict = fresh.length > 0 ? this.onLines(fresh) : undefined;
        // A line the other reading holds open from where it began (stderr's `Password: `, the read's ended at stdout's
        // LF) is that reading's prompt's twin, or its completed line's when the text is the same.
        for (const line of fresh) if (line.begun && this.heldOpen(line.begun)) this.completed.set(placeOf(line.begun, line), { at: line.begun, verdict, text: line.text });
      }
      this.pruneTwins();
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
    r.last = ev.seq;
    return r.splitter.feed(ev.data, r.pipe === undefined ? ev.stream : undefined, ev.seq);
  }

  /**
   * A completed line, as one reading or both wrote it (`texts`, the pipe's first): tested for what its place still
   * allows. Nothing after a fail there, a quiet prompt's whose reading spent it while the other's went on to complete
   * it; fail alone after a ready, stdout's `server ready` matched quiet and then ` FATAL` and a LF, or stderr's
   * `FATAL` and a LF ending the read's line begun at it (the house's review of 4860d4c..bc4bc85, #22, comment
   * 6357989601). The place's verdict now.
   */
  private onLines(texts: SplitLine[]): Verdict {
    return this.onLine(texts, texts.reduce<Verdict>((v, line) => stronger(v, this.prompted.get(placeOf(line.begun, line))?.verdict), undefined));
  }

  /**
   * A quiet prompt `r` offered: tested together with its twins, the other readings' open lines that hold bytes of its
   * own (twins), all texts at once (the pipes' first), as a completed pair is, for what their places still allow, and
   * the verdict recorded under every place, so a twin's own offer finds it. Taken alone, the first offer's verdict
   * stood for its twin's different text: stderr's `Password: ` was never tested when the read's `Passxword: ` had
   * failed. Told apart by the seq each reading was last fed, one prompt counted twice when the other pipe wrote in
   * between (our review of the 73 commits through 4860d4c, PR #22). A twin the other reading has already ended was
   * matched as a completed line: a fail there spends the prompt with it, a ready leaves the prompt's text to be tried
   * for fail (stdout's `READY FA` ended by stderr's LF in the read, then `TAL` on stdout), and otherwise the prompt's
   * own text is tried. Paired only with an open twin, stderr's `Password: ` matched again after the read had matched
   * it, ended at stdout's LF (the house's review of a8b6f28..4860d4c, #22, comment 6341260318, question 6). True
   * spends the line in its splitter: only a fail is final, so a ready prompt is offered again as its line grows and
   * comes out once more when it completes, each time tested for fail alone (the house's review of 4860d4c..bc4bc85,
   * #22, comment 6357989601).
   */
  private once(r: Reading, line: SplitLine): boolean {
    const at = placeOf(line.begun, line);
    const own = this.judged(at);
    if (own === 'fail') {
      this.prompted.set(at, { at: line.begun, verdict: own });
      return true;
    }
    // Its twins' places too: stdout's `READY FA` ended by stderr's LF in the read is the completed line stdout's open
    // `READY FATAL` continues, and the read's `TAL` offered first is that prompt's twin.
    const twins = this.twins(r, line);
    const sofar = twins.reduce<Verdict>((v, t) => stronger(v, this.judged(placeOf(t.begun, t))), own);
    const verdict = this.onLine(r.pipe !== undefined ? [line, ...twins] : [...twins, line], sofar);
    for (const l of [line, ...twins]) this.prompted.set(placeOf(l.begun, l), { at: l.begun, verdict });
    return verdict === 'fail';
  }

  /** What a place has been judged so far, as a quiet prompt (prompted) or as a line one reading completed (completed). */
  private judged(at: string): Verdict {
    return stronger(this.prompted.get(at)?.verdict, this.completed.get(at)?.verdict);
  }

  /**
   * The other readings' open lines that hold bytes of a quiet prompt's line, with their text, the pipes' first: the
   * read's open line and every pipe's open line written to since the read's line began, begun inside it (stderr's
   * `FATAL` after stdout's `server ready`) or before it (stdout's `Server listening on 8080`, the read's `ing on 8080`
   * begun after stderr's LF), whichever of them offers. A pipe's open line written before the read's line began shares
   * no byte with it, nor with another pipe's, and has no twin. Paired by where they began alone, stdout's `server ready`
   * left quiet and then stderr's `FATAL` left quiet counted the FATAL twice, in the read's `server readyFATAL` and in
   * stderr's `FATAL`, where stderr's LF ending both counted it once (an independent read of the fixes for PR #22
   * comment 6357989601). The whole group at once: stdout's `x` paired with the read's `Passxword: ` alone matched
   * ready, where stderr's `Password: `, the read's other twin, fails.
   */
  private twins(r: Reading, line: SplitLine): SplitLine[] {
    const read = this.lines;
    const began = r.pipe === undefined ? line.begun : read?.splitter.opened();
    if (!read || !began || (r !== read && (r.last === undefined || r.last < began.at))) return [];
    const open = (o: Reading): SplitLine[] => {
      const t = o === r ? undefined : o.splitter.peek();
      return t ? [t] : [];
    };
    return [...[...this.pipes.values()].filter((p) => p.last !== undefined && p.last >= began.at).flatMap(open), ...open(read)];
  }

  /** A completed line the other reading completed already, begun at the same place with the same text. */
  private sameCompleted(line: SplitLine): boolean {
    return line.begun !== undefined && this.completed.get(placeOf(line.begun, line))?.text === line.text;
  }

  /** Whether a reading holds open a line that began at `p`: read where it began, without building its text. */
  private heldOpen(p: Begun): boolean {
    if (this.lines && samePlace(this.lines.splitter.opened(), p)) return true;
    for (const o of this.pipes.values()) if (samePlace(o.splitter.opened(), p)) return true;
    return false;
  }

  /** A prompt's entry, or a completed line's, goes once no reading holds its line open. */
  private pruneTwins(): void {
    if (this.prompted.size === 0 && this.completed.size === 0) return;
    for (const twins of [this.prompted, this.completed]) for (const [key, t] of twins) if (!t.at || !this.heldOpen(t.at)) twins.delete(key);
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
   * began where it did. Tested for what its place's verdict `sofar` still allows: nothing after a fail; fail alone
   * after a ready, so a ready read before a fail on another line is no recovery (stdout's `ready` quiet, stderr's
   * `FATAL` and LF, then stdout's LF ending its `ready` leaves the service unhealthy); else fail, then ready. A fail
   * match wins over a ready match on the same line, in either reading; the evidence is the first reading that
   * matched. It names the line, whichever reading it is: m2-21's says `Server listening on 8080`. The place's verdict
   * now.
   */
  private onLine(texts: SplitLine[], sofar: Verdict): Verdict {
    if (this.disposed || ended(this.statusValue) || sofar === 'fail') return sofar;
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
      return 'fail';
    }
    if (sofar === 'ready') return sofar;
    const ready = first(this.readyRe);
    if (ready !== undefined) {
      this.onReadyLine(ready);
      return 'ready';
    }
    return undefined;
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
    this.completed.clear();
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
