/**
 * Control-sequence stripping for *matching* only (probes, watches, search
 * previews). Rendering text for reading goes through the transcript projection
 * (§6), never through this.
 */
import { err } from './errors.js';
import { compileUserRegex } from './regex.js';

// CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC strings, and two-byte escapes.
const SEQ = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_X][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
// C0 controls other than tab and newline (CR is kept for the line splitter below).
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(s: string): string {
  return s.replace(SEQ, '').replace(CTRL, '');
}

/** The longest line a StreamMatcher holds: a longer one is matched in pieces of this size. */
export const MAX_LINE = 64 * 1024;

/** How long a stream must be quiet before its unterminated line (a prompt like `Password:`) is matched. */
export const PARTIAL_QUIET_MS = 500;

/**
 * Compile a caller's line pattern (watch, wait_for, `ready.pattern`, `fail.pattern`):
 * on the linear-time engine (`compileUserRegex`), and refused when it matches the
 * empty string, since it would then match every line (`x*`, `(error)?`, `^$`).
 * Throws invalid_argument, so a bad pattern fails when the watch or service is
 * created, never later.
 */
export function compileLinePattern(pattern: string): RegExp {
  const re = compileUserRegex(pattern);
  if (re.test('')) throw err('invalid_argument', `pattern /${pattern}/ matches the empty string, so it would match every line: make it require at least one character`);
  return re;
}

export interface LineMatch {
  /** The text the pattern matched. */
  match: string;
  /** The whole line it was found in, control sequences stripped. */
  line: string;
}

export interface LineSplitterOptions {
  /**
   * Offered the unterminated line (stripped) once the stream has been quiet for
   * `partialAfterMs`; it runs from a timer, not from `feed`. Returning true spends
   * the line: it is not returned again when it completes. Without it, only
   * terminated lines come out.
   */
  onPartial?: (line: string) => boolean;
  /** Quiet period before the unterminated line is offered (ms); default PARTIAL_QUIET_MS. */
  partialAfterMs?: number;
}

/**
 * Cuts one output stream into lines, the way `search` reads it: LF, CRLF or a lone
 * CR ends a line, and control sequences are stripped from each complete line (a
 * sequence split by a write completes before it is stripped). Empty lines are
 * dropped. A line longer than MAX_LINE comes out in pieces of that size, so memory
 * and a regex's work per line stay bounded. The unterminated line (a prompt:
 * `Password: `, `>>> `) can be offered once the stream has gone quiet. One splitter
 * per stream: interleaving two streams' writes would join their partial lines.
 */
export class LineSplitter {
  /** The unterminated line, raw. */
  private raw = '';
  /** The last chunk ended in CR: an LF opening the next one belongs to it. */
  private pendingCr = false;
  /** The unterminated line was consumed as a prompt. */
  private spent = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly quietMs: number;
  private readonly onPartial: ((line: string) => boolean) | undefined;

  constructor(opts: LineSplitterOptions = {}) {
    this.quietMs = opts.partialAfterMs ?? PARTIAL_QUIET_MS;
    this.onPartial = opts.onPartial;
  }

  /** Feed a chunk; returns the lines it completed, in order. */
  feed(chunk: string): string[] {
    const out: string[] = [];
    if (!chunk) return out;
    let text = chunk;
    if (this.pendingCr && text.startsWith('\n')) text = text.slice(1);
    this.pendingCr = text.endsWith('\r');
    const parts = text.split(/\r\n|\r|\n/);
    const last = parts.pop()!;
    for (const part of parts) {
      this.raw += part;
      this.complete(out);
    }
    this.raw += last;
    while (this.raw.length > MAX_LINE) {
      // A line this long is cut; the rest starts a new piece.
      const rest = this.raw.slice(MAX_LINE);
      this.raw = this.raw.slice(0, MAX_LINE);
      this.complete(out);
      this.raw = rest;
    }
    this.schedulePartial();
    return out;
  }

  /** The stream ended: the unterminated line is complete (unless it was spent as a prompt). */
  flush(): string[] {
    const out: string[] = [];
    this.complete(out);
    this.pendingCr = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return out;
  }

  /** Stop the quiet timer; nothing is offered afterwards. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private complete(out: string[]): void {
    const raw = this.raw;
    const spent = this.spent;
    this.raw = '';
    this.spent = false;
    if (spent) return;
    for (let i = 0; i < raw.length; i += MAX_LINE) {
      const line = stripAnsi(raw.slice(i, i + MAX_LINE));
      if (line) out.push(line);
    }
  }

  private schedulePartial(): void {
    if (!this.onPartial || this.quietMs <= 0) return;
    if (!this.raw || this.spent) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    // Output restarts the quiet period; refreshing the pending timer is cheaper than a new one per chunk.
    if (this.timer) {
      this.timer.refresh();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const line = this.spent ? '' : stripAnsi(this.raw);
      if (line && this.onPartial?.(line)) this.spent = true;
    }, this.quietMs);
    // A pending prompt check never keeps the process alive; whoever waits on it has its own timer.
    this.timer.unref();
  }
}

export interface StreamMatcherOptions {
  /**
   * Receives a match found in the unterminated line once the stream has been quiet
   * for `partialAfterMs` (it arrives from a timer). Without it, only terminated
   * lines are matched.
   */
  onPartial?: (m: LineMatch) => void;
  /** Quiet period before the unterminated line is matched (ms); default PARTIAL_QUIET_MS. */
  partialAfterMs?: number;
}

/**
 * One pattern over one output stream, with the semantics `search` has: each line
 * (see LineSplitter) is tested once, so `^` and `$` mean the line's start and end
 * wherever the writes happened to split. A line yields at most one match, its
 * first, reported when the line is complete, so a split write is never reported
 * cut short and no text is matched twice. An unterminated line is matched once
 * the stream has been quiet for `partialAfterMs` when `onPartial` is given; a
 * line that matched that way is not matched again when it completes.
 */
export class StreamMatcher {
  private readonly lines: LineSplitter;

  /** `re` comes from `compileLinePattern`. */
  constructor(
    private readonly re: RegExp,
    o: StreamMatcherOptions = {},
  ) {
    const onPartial = o.onPartial;
    const split: LineSplitterOptions = {};
    if (onPartial) {
      split.onPartial = (line) => {
        const hit = this.test(line);
        if (hit) onPartial(hit);
        return hit !== undefined;
      };
    }
    if (o.partialAfterMs !== undefined) split.partialAfterMs = o.partialAfterMs;
    this.lines = new LineSplitter(split);
  }

  /** Feed a chunk; returns the matches of the lines it completed. */
  feed(chunk: string): LineMatch[] {
    return this.collect(this.lines.feed(chunk));
  }

  /** The stream ended: match its unterminated line now. */
  flush(): LineMatch[] {
    return this.collect(this.lines.flush());
  }

  dispose(): void {
    this.lines.dispose();
  }

  private collect(lines: string[]): LineMatch[] {
    const out: LineMatch[] = [];
    for (const line of lines) {
      const hit = this.test(line);
      if (hit) out.push(hit);
    }
    return out;
  }

  private test(line: string): LineMatch | undefined {
    const m = this.re.exec(line);
    return m ? { match: m[0], line } : undefined;
  }
}
