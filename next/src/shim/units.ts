/**
 * What a supervisor's unit says termd is started with, read from the unit's text: the shim asks
 * launchd or systemd whether a termd is managed for this user, and on which port and data dir, before
 * it starts one of its own (see stdio.ts). Each reader gives the unit's arguments, one entry per word
 * as termd receives them, and its environment, so that a value with spaces stays whole (the house's
 * read of the 38 commits, #22 comment 6274370651), or says the text cannot tell them: then the port
 * and data dir are unknown, never termd's defaults. Apart from stdio.ts so each reader can be run on
 * a text of a test's own, on any platform (the house's read of the 33 commits, #22 comment 6307350861).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setting } from '../core/env.js';

export interface UnitText {
  argv: string[];
  env: Record<string, string>;
}

/**
 * A `launchctl print` answer: the `arguments = { … }` and `environment = { … }` blocks of the job,
 * one entry per line, indented two tabs. An entry is kept as printed past its indent: trimmed, a
 * value's own leading or trailing spaces went. Undefined without an arguments block: launchctl prints
 * none for a job naming `Program` alone, whose program's own arguments are not shown, and read as no
 * arguments it was taken for termd's defaults (the house's read of the 33 commits, #22 comment
 * 6307350861), as `plistUnit` already refuses such a plist.
 */
export function launchctlUnit(out: string): UnitText | undefined {
  const block = (name: string): string[] | undefined => {
    const m = new RegExp(`^\\t${name} = \\{\\n([\\s\\S]*?)^\\t\\}$`, 'm').exec(out);
    return m ? m[1]!.split('\n').filter((l) => l.startsWith('\t\t')).map((l) => l.slice(2)) : undefined;
  };
  const argv = block('arguments');
  if (argv === undefined) return undefined;
  const env: Record<string, string> = {};
  for (const line of block('environment') ?? []) {
    const m = /^(\w+) =>(?: (.*))?$/.exec(line);
    if (m) env[m[1]!] = m[2] ?? '';
  }
  return { argv, env };
}

/**
 * A `systemctl show` answer: `argv[]=` inside ExecStart and Environment's words. Undefined when
 * ExecStart is empty or has text in a shape not read here, since its port and data dir are then
 * unknown: read as no arguments, an empty ExecStart was termd's defaults (the house's read of the 40
 * commits, #22).
 *
 * The argv is what systemd runs, as it runs it (systemd 255, probed with a user unit): `systemctl
 * show` prints a unit file's specifiers (`%h`) already expanded, while `${NAME}` in an argument is
 * expanded only when it runs, from the unit's environment and the manager's (HOME, for a user unit),
 * so it is expanded here; an argument with `$NAME` joined to other text (`$HOME/x`) reached the
 * program not at all, so such an argv is unknown, as is one naming a variable that is not known here;
 * `~` systemd leaves as it is, as termd does.
 *
 * systemd prints ExecStart's argv unquoted, its words joined by one space each, so an option's value
 * is the words up to the next option, joined by the spaces between them: a run of spaces inside a
 * value, or one at either end, is kept. Dropped, `--data-dir /home/a/my  data` read back as
 * `/home/a/my data` (the house's read of the 33 commits, #22 comment 6307350861). What the text cannot
 * tell is a value holding a word that starts with `--`, which reads as a second option; should that
 * misread leave the shim starting a termd out of the unit's own data dir, termd's lock on the data dir
 * refuses it, and the shim reports what termd said.
 */
export function systemctlUnit(execStart: string, environment: string): UnitText | undefined {
  if (!execStart) return undefined;
  const m = /argv\[\]=(.*?)(?: ; |\s*\}\s*$|$)/.exec(execStart);
  if (!m) return undefined;
  const env: Record<string, string> = {};
  for (const word of quotedWords(environment)) {
    const eq = word.indexOf('=');
    if (eq > 0) env[word.slice(0, eq)] = word.slice(eq + 1);
  }
  const words: string[] = [];
  for (const w of m[1]!.split(' ')) {
    let unknown = false;
    const x = w.replace(/\$\{(\w+)\}|\$/g, (all, name: string | undefined) => {
      const v = name === undefined ? undefined : (env[name] ?? (name === 'HOME' ? os.homedir() : undefined));
      if (v === undefined) unknown = true;
      return v ?? all;
    });
    if (unknown) return undefined;
    words.push(x);
  }
  return { argv: joinOptionValues(words), env };
}

/** Words of a list systemd prints, double-quoted where a word has spaces (`\"` and `\\` inside stand for the characters). */
function quotedWords(text: string): string[] {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const m of text.matchAll(re)) words.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!);
  return words;
}

/**
 * Words of a command line split at each space, re-joined so each option's value is one entry: the
 * words after an option, up to the next one, are its value, empty words (a run of spaces) included
 * (the launcher's flags each take one value or none, and nothing positional follows them). Words
 * before the first option are left as they are.
 */
function joinOptionValues(words: string[]): string[] {
  const out: string[] = [];
  let options = false;
  let inValue = false;
  for (const w of words) {
    if (w.startsWith('--')) {
      options = true;
      out.push(w);
      inValue = w.includes('='); // `--flag=value`: more words belong to the value
    } else if (!options) out.push(w);
    else if (inValue) out[out.length - 1] += ` ${w}`;
    else {
      out.push(w);
      inValue = true;
    }
  }
  return out;
}

/**
 * The value a unit gives an option: the entry after `--flag`, or what follows `--flag=`; undefined
 * when the flag is absent, null when it has no value — an empty one included, which termd refuses
 * as it refuses a missing one. An option given twice takes its last value, as termd's parseArgs
 * does: the first one read `/a` where termd used `/b` (the house's read of the 40 commits, #22).
 */
export function unitArg(u: UnitText, flag: string): string | undefined | null {
  let i = u.argv.length - 1;
  while (i >= 0 && !(u.argv[i] === flag || u.argv[i]!.startsWith(`${flag}=`))) i--;
  if (i < 0) return undefined;
  const a = u.argv[i]!;
  if (a.length > flag.length) return a.slice(flag.length + 1) || null;
  const next = u.argv[i + 1];
  return next === undefined || next === '' || next.startsWith('--') ? null : next;
}

/**
 * The port a unit gives termd: `--port N` (`--port=N`), else TSM_PORT, else SESSION_SERVER_PORT in
 * its environment — the order termd reads them in, so a unit that sets both is read as termd reads it
 * (the house's read of the shim, #22 comment 6269349177) — else termd's default. An empty variable is
 * unset, as for termd: read as the port, `TSM_PORT= SESSION_SERVER_PORT=4100` was port "" where termd
 * listens on 4100 (the house's read of the 33 commits, #22 comment 6307350861). Undefined when the
 * unit names the flag without a value, which termd refuses: read on, `--port` with TSM_PORT=4100 was
 * port 4100 and `--port=` port 3101 (the house's read of the 40 commits, #22).
 */
export function unitPort(u: UnitText): string | undefined {
  const arg = unitArg(u, '--port');
  if (arg === null) return undefined;
  return arg ?? setting('TSM_PORT', u.env) ?? setting('SESSION_SERVER_PORT', u.env) ?? '3101';
}

/**
 * The data dir a unit's termd uses: `--data-dir`, else TSM_DATA_DIR in its environment (empty is
 * unset, as for termd), else termd's default; undefined when the unit names the flag without a
 * value, since nothing then says which dir it is. termd resolves the value from its working
 * directory, this user's $HOME (the launcher starts there), and expands nothing, so neither does
 * this: a supervisor's own expansions are made where its text is read (systemctlUnit). Expanded
 * here, a unit's `--data-dir ~/x` read as $HOME/x while termd used $HOME/~/x, since neither systemd
 * nor launchd expands `~` (the house's read of the 40 commits, #22).
 */
export function unitDataDir(u: UnitText): string | undefined {
  const arg = unitArg(u, '--data-dir');
  if (arg === null) return undefined;
  const named = arg ?? setting('TSM_DATA_DIR', u.env);
  const home = os.homedir();
  if (named === undefined) return path.join(home, '.tsm');
  return path.resolve(home, named);
}

/**
 * A LaunchAgent's plist: ProgramArguments' `<string>`s, whole, and EnvironmentVariables' pairs; or
 * why it could not be read. A plist without a ProgramArguments array in XML is not read as no
 * arguments: a binary plist (as `plutil -convert binary1` writes it) has no text to find them in, and a
 * job naming `Program` alone runs a program whose own arguments are not here; either was taken for
 * termd's defaults (a reviewer's read of the fixes for #22).
 */
export function plistUnit(file: string): UnitText | { error: string } {
  let xml: string;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { error: (e as NodeJS.ErrnoException).code ?? (e as Error).message };
  }
  if (xml.startsWith('bplist')) return { error: 'a binary plist, which is not read here' };
  const text = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1];
  if (args === undefined) return { error: 'no ProgramArguments array in it' };
  const argv = [...args.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => text(m[1]!));
  const env: Record<string, string> = {};
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml)?.[1] ?? '';
  // A key holds no markup, and `<string/>` is an empty value: a lazy key ran on over one, and the key
  // after it was lost (the house's read of the 40 commits, #22).
  for (const m of dict.matchAll(/<key>([^<]*)<\/key>\s*(?:<string>([\s\S]*?)<\/string>|<string\s*\/>)/g)) env[text(m[1]!)] = text(m[2] ?? '');
  return { argv, env };
}
