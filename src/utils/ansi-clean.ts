/**
 * ANSI Escape Code Cleaning Utility
 * 
 * Strips ANSI codes and intelligently handles terminal output
 * to produce clean, readable text for AI consumption.
 */

// Regex patterns for various ANSI escape sequences
const ANSI_PATTERNS = {
  // CSI (Control Sequence Introducer) sequences: ESC [ ... final_byte
  // Full CSI grammar: parameter bytes (0x30-0x3F, covers digits ; : ? >),
  // intermediate bytes (0x20-0x2F), one final byte (0x40-0x7E). A letters-only
  // final byte match would leave residue like "[1@" from insert-character
  // sequences (ESC[1@) or "[2 q" from cursor-style sequences (ESC[2 q).
  csi: /\x1b\[[0-?]*[ -/]*[@-~]/g,
  
  // OSC (Operating System Command) sequences: ESC ] ... BEL or ESC \
  // Used for window titles, hyperlinks, etc.
  osc: /\x1b\].*?(?:\x07|\x1b\\)/g,
  
  // The remaining escape sequences (ECMA-48), stripped after CSI/OSC/DCS so
  // those keep their own patterns: SS3 (ESC O + one char), nF (ESC, one or
  // more intermediate bytes 0x20-0x2F, a final byte, e.g. ESC ( B charset
  // selection), and two-character Fp/Fe/Fs sequences (ESC + 0x30-0x7E, e.g.
  // ESC > / ESC = keypad mode that less prints on exit, ESC 7 / ESC 8, ESC M).
  // Matching only ESC ( / ESC ) used to leave the final byte, like a stray ">".
  singleChar: /\x1bO[@-~]|\x1b[ -/]+[0-~]|\x1b[0-~]/g,
  
  // DCS (Device Control String) and other sequences
  dcs: /\x1b[PX^_].*?(?:\x1b\\|\x07)/g,
  
  // Private mode sequences: ESC [ ? ... h/l
  privateMode: /\x1b\[\?[0-9;]*[hl]/g,
  
  // SGR reset and basic escape
  escape: /\x1b/g,
  
  // Control characters (except \n, \r, \t which we handle specially)
  controlChars: /[\x00-\x08\x0b\x0c\x0e-\x1f]/g,
};

/**
 * Options for cleaning terminal output
 */
export interface CleanOptions {
  /** If true, preserve raw ANSI codes */
  raw?: boolean;
  /** If true, collapse multiple blank lines into one */
  collapseBlankLines?: boolean;
  /** If true, trim trailing whitespace from lines */
  trimLines?: boolean;
}

const DEFAULT_OPTIONS: CleanOptions = {
  raw: false,
  collapseBlankLines: true,
  trimLines: true,
};

/**
 * Strip all ANSI escape sequences from a string
 */
export function stripAnsi(text: string): string {
  let result = text;
  
  // Strip in order of specificity
  result = result.replace(ANSI_PATTERNS.osc, '');
  result = result.replace(ANSI_PATTERNS.dcs, '');
  result = result.replace(ANSI_PATTERNS.csi, '');
  result = result.replace(ANSI_PATTERNS.privateMode, '');
  result = result.replace(ANSI_PATTERNS.singleChar, '');
  result = result.replace(ANSI_PATTERNS.controlChars, '');
  
  // Clean up any remaining bare escape characters
  result = result.replace(ANSI_PATTERNS.escape, '');
  
  return result;
}

/**
 * Handle carriage returns intelligently
 * 
 * Progress bars and spinners use \r to overwrite lines.
 * This function shows only the final state of each line.
 * 
 * Example:
 *   "Downloading 10%\rDownloading 50%\rDownloading 100%"
 *   becomes: "Downloading 100%"
 */
export function handleCarriageReturns(text: string): string {
  // Split by newlines, process each line
  const lines = text.split('\n');
  
  return lines.map(line => {
    // If line contains \r, keep only the content after the last \r
    // (unless the \r is at the very end, which just means "return to start")
    if (line.includes('\r')) {
      const segments = line.split('\r');
      // Filter out empty segments and get the last non-empty one
      const nonEmpty = segments.filter(s => s.length > 0);
      if (nonEmpty.length > 0) {
        return nonEmpty[nonEmpty.length - 1];
      }
      return '';
    }
    return line;
  }).join('\n');
}

/**
 * Collapse multiple consecutive blank lines into a single blank line
 */
export function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Trim trailing whitespace from each line
 */
export function trimLineWhitespace(text: string): string {
  return text.split('\n').map(line => line.trimEnd()).join('\n');
}

/**
 * Clean terminal output for AI consumption
 * 
 * This is the main function to use. It:
 * 1. Strips ANSI color codes, cursor movement, mode switching
 * 2. Handles carriage returns intelligently (shows final state)
 * 3. Optionally collapses whitespace
 * 4. Preserves actual newlines and text content
 */
export function cleanTerminalOutput(text: string, options?: CleanOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  // If raw mode, return as-is
  if (opts.raw) {
    return text;
  }
  
  let result = text;
  
  // Step 1: Strip ANSI sequences
  result = stripAnsi(result);
  
  // Step 2: Handle carriage returns (progress bars, spinners)
  result = handleCarriageReturns(result);
  
  // Step 3: Trim line whitespace if requested
  if (opts.trimLines) {
    result = trimLineWhitespace(result);
  }
  
  // Step 4: Collapse blank lines if requested
  if (opts.collapseBlankLines) {
    result = collapseBlankLines(result);
  }
  
  // Final trim
  return result.trim();
}

/**
 * Clean an array of log lines
 */
export function cleanLogLines(lines: string[], options?: CleanOptions): string[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  if (opts.raw) {
    return lines;
  }
  
  // Join, clean as a single block (to handle cross-line issues), then split
  const cleaned = cleanTerminalOutput(lines.join('\n'), opts);
  
  // Split and filter out empty lines if collapsing
  let result = cleaned.split('\n');
  
  if (opts.collapseBlankLines) {
    // Remove leading/trailing empty lines from the array
    while (result.length > 0 && result[0] === '') {
      result.shift();
    }
    while (result.length > 0 && result[result.length - 1] === '') {
      result.pop();
    }
  }
  
  return result;
}
