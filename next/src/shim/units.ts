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
import { parseEnvNul, setting } from '../core/env.js';

export interface UnitText {
  argv: string[];
  env: Record<string, string>;
  /**
   * A source of the environment termd is given that is not read here (systemd's EnvironmentFile=):
   * a variable termd would read is then unknown, neither `env`'s nor termd's default, unless an `env`
   * prefix on the command line sets it (`fixed`). An argument that expands one of its variables holds
   * UNREAD where the value goes.
   */
  unreadEnv?: string;
  /** Variables an `env` prefix set or took away, so no file decides them; `all` after `env -i`. */
  fixed?: Set<string> | 'all';
  /** Why no option or variable termd reads can be told from the text at all, worded to follow the unit's name. */
  unclear?: string;
}

/** Stands in an argument for the value of a variable an unread EnvironmentFile= may set. */
const UNREAD = '\u0000';

/** Why a value a unit gives termd cannot be told from its text, worded to follow the unit's name. */
export interface Unknown {
  unknown: string;
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
  return throughEnv({ argv, env });
}

/**
 * A `systemctl show` answer: `argv[]=` inside ExecStart and the environment systemd gives the unit's
 * process. Undefined when ExecStart is empty or has text in a shape not read here, since its port and
 * data dir are then unknown: read as no arguments, an empty ExecStart was termd's defaults (the house's
 * read of the 40 commits, #22).
 *
 * The environment is built as systemd builds it (systemd 257, probed with a user unit): the user
 * manager's own environment (`more.manager`, its Environment property), then the unit's
 * Environment=, whose values win over it, then its EnvironmentFile=s, whose win again, less what
 * UnsetEnvironment= names (a variable, or one assignment of it). So a TSM_DATA_DIR a login imported
 * into the manager (`systemctl --user import-environment`, as desktop sessions do) is termd's, where
 * read from Environment= alone it was taken for unset. The files are not read: systemd
 * reads them when the unit starts, not when the shim asks (an ExecStartPre= may write one, and a
 * running termd has what they said at its start), through a grammar of quotes, escapes and continued
 * lines, skipping a missing `-` file and taking every file a glob names; read wrong, the port or data
 * dir compared would be another than termd's, and the shim would start a termd where the unit's runs,
 * which the check is there to prevent. So a unit naming one has every variable termd reads unknown
 * (`unreadEnv`), unless an `env` prefix sets it, while an option on its command line stays known, since
 * termd reads that first (the house's read of the 40 commits through f3750e4, #22 comment 6310921374).
 * A `${NAME}` the file may set is unknown too, but systemd makes it exactly one argument, so only what
 * it can be is unknown: the value of the option it follows, or, standing where termd could read it as
 * an option of its own (a word past the first option that is not a flag's first value), any option, the
 * port and data dir with it. Read as unknown wherever it stood, one `${NAME}` made a literal `--port` and
 * `--data-dir` unknown too (the house's review of f3750e4..4f4c067, #22 comment 6315636412).
 *
 * `more.running` is the environment the unit's running termd has (`procEnviron`): what systemd gave it
 * when it started, the files and the manager's environment then included, which a variable imported
 * into the manager since does not change. Given, it is the environment, whole.
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
export function systemctlUnit(execStart: string, environment: string, more: { manager?: string; files?: readonly string[]; unset?: string; running?: Record<string, string> } = {}): UnitText | undefined {
  if (!execStart) return undefined;
  const m = /argv\[\]=(.*?)(?: ; |\s*\}\s*$|$)/.exec(execStart);
  if (!m) return undefined;
  if (more.running) return runningUnit(m[1]!.split(' '), more.running);
  const env: Record<string, string> = {};
  for (const word of [...quotedWords(more.manager ?? ''), ...quotedWords(environment)]) {
    const eq = word.indexOf('=');
    if (eq > 0) env[word.slice(0, eq)] = word.slice(eq + 1);
  }
  for (const word of quotedWords(more.unset ?? '')) {
    const eq = word.indexOf('=');
    const name = eq < 0 ? word : word.slice(0, eq);
    if (eq < 0 || env[name] === word.slice(eq + 1)) delete env[name];
  }
  // systemctl prints each as `<path> (ignore_errors=yes|no)`, the `-` of an optional one as the flag.
  const files = (more.files ?? []).map((f) => f.replace(/ \(ignore_errors=\w+\)$/, ''));
  const unreadEnv = files.length ? `EnvironmentFile=${files.join(', ')}` : undefined;
  const words: string[] = [];
  for (const w of m[1]!.split(' ')) {
    let unknown = false;
    const x = w.replace(/\$\{(\w+)\}|\$/g, (all, name: string | undefined) => {
      // A file may set any variable, HOME too. HOME is in the manager's environment; one the unit's takes
      // away (UnsetEnvironment=HOME) systemd expands to nothing, where this shim's own home was put in (the
      // house's read of the 40 commits over our fixes, #22; systemd 255, probed with transient user units).
      if (name !== undefined && unreadEnv) return UNREAD;
      const v = name === undefined ? undefined : env[name];
      if (v === undefined) unknown = true;
      return v ?? all;
    });
    if (unknown) return undefined;
    words.push(x);
  }
  // env's own options start with `--` too, so it is read before the words are joined into option values.
  // systemctl's text is unquoted, so env's program must be a path: a word that is not one may be the rest
  // of an assignment's value with a space in it.
  const u = throughEnv({ argv: words, env }, { program: 'path' });
  if (unreadEnv) {
    u.unreadEnv = unreadEnv;
    const loose = looseExpansion(u.argv);
    if (loose && !u.unclear) u.unclear = `passes ${loose} from ${unreadEnv} where termd may read it as an option of its own`;
  }
  u.argv = joinOptionValues(u.argv);
  return u;
}

/**
 * A running unit's text read against its termd's own environment, which is what systemd and any `env` prefix
 * made of it: the prefix is read only to find termd's arguments, never applied again, and a `${NAME}` in those
 * arguments that the prefix sets or takes away (any, after `-i`) is unknown, since systemd expanded it before
 * env ran, from a value the running environment no longer holds. Applied again, `env
 * TSM_DATA_DIR=${TSM_DATA_DIR}/x` read as …/x/x (the house's read of the 17 commits over our fixes, #22).
 */
function runningUnit(text: string[], running: Record<string, string>): UnitText | undefined {
  const env = { ...running };
  const t = throughEnv({ argv: text, env: {} }, { program: 'path' });
  if (t.unclear) return { argv: [], env, unclear: t.unclear };
  const words: string[] = [];
  for (const w of t.argv) {
    let unknown = false;
    const x = w.replace(/\$\{(\w+)\}|\$/g, (all, name: string | undefined) => {
      const v = name === undefined || t.fixed === 'all' || t.fixed?.has(name) ? undefined : env[name];
      if (v === undefined) unknown = true;
      return v ?? all;
    });
    if (unknown) return undefined;
    words.push(x);
  }
  return { argv: joinOptionValues(words), env };
}

/**
 * termd's flags that take no value (daemon.ts's FLAGS, which a spec holds this to). The word after one is
 * an argument of its own, not the flag's value.
 */
export const TERMD_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['--help', '--no-usage-log', '--headless']);

/**
 * The first argument past the first option that an expansion may make an option of its own: a flag
 * whose name holds one, or a word that begins with one and is not the first value of the flag before
 * it, a flag that takes no value having none: read as `--headless`'s value, a `--headless ${X}` whose X
 * a file sets to `--data-dir=/x` passed unflagged (the house's review of 4f4c067..a8b6f28, #22 comment
 * 6323055715). Before the first option stand the launcher and its script, and an option there is
 * overridden by a later literal one (termd takes an option's last value) or falls to the environment,
 * unknown already.
 */
function looseExpansion(argv: readonly string[]): string | undefined {
  let options = false;
  let firstValue = false;
  for (const w of argv) {
    if (w.startsWith('--')) {
      options = true;
      if (w.slice(0, (w.indexOf('=') + 1 || w.length + 1) - 1).includes(UNREAD)) return `an option named by a variable (${w.replaceAll(UNREAD, '${…}')})`;
      firstValue = !w.includes('=') && !TERMD_BOOLEAN_FLAGS.has(w);
    } else if (options) {
      if (!firstValue && w.startsWith(UNREAD)) return `an argument (${w.replaceAll(UNREAD, '${…}')})`;
      firstValue = false;
    }
  }
  return undefined;
}

/**
 * A command line run through `env`, as env applies it: its assignments and `-u`/`--unset` change the
 * environment the program after them gets, `-i` (`-`, `--ignore-environment`) starts it empty, `--`
 * ends its options, and the program's own arguments follow; env run by env applies again. Read as
 * arguments, `env TSM_PORT=4100 /bin/sh termd-launch.sh` was port 3101 (the house's review of
 * f3750e4..4f4c067, #22 comment 6315636412). Any other option of env (`-C` changes the directory a
 * relative data dir is taken from, `-S` splits a string) is not read: then nothing is known
 * (`unclear`). What env sets or takes away is `fixed`, so no EnvironmentFile= decides it.
 */
function throughEnv(u: UnitText, o: { program?: 'path' } = {}): UnitText {
  let argv = u.argv;
  const env = { ...u.env };
  let fixed: Set<string> | 'all' | undefined;
  const fix = (name: string) => {
    if (fixed === 'all') return;
    fixed ??= new Set();
    fixed.add(name);
  };
  const unclear = (why: string): UnitText => ({ ...u, unclear: why });
  while (argv.length && path.basename(argv[0]!) === 'env') {
    let i = 1;
    for (; i < argv.length; i++) {
      const w = argv[i]!;
      if (w === '--') {
        i++;
        break;
      }
      if (w === '-i' || w === '-' || w === '--ignore-environment') {
        for (const k of Object.keys(env)) delete env[k];
        fixed = 'all';
      } else if (w === '-u' || w === '--unset' || w.startsWith('--unset=') || /^-u./.test(w)) {
        const name = w === '-u' || w === '--unset' ? argv[++i] : w.startsWith('--unset=') ? w.slice('--unset='.length) : w.slice(2);
        if (!name) return unclear(`runs env with ${w} and no name after it`);
        delete env[name];
        fix(name);
      } else if (w === '-v' || w === '--debug') continue;
      else if (w.startsWith('-')) return unclear(`runs env with ${w.replaceAll(UNREAD, '${…}')}, which is not read here`);
      else break;
    }
    for (; i < argv.length && argv[i]!.includes('='); i++) {
      const w = argv[i]!;
      const eq = w.indexOf('=');
      if (eq === 0) return unclear(`runs env with ${w}, which it refuses`);
      env[w.slice(0, eq)] = w.slice(eq + 1);
      fix(w.slice(0, eq));
    }
    const program = argv[i];
    if (program === undefined) return unclear('runs env with no program after it');
    if (o.program === 'path' && !program.startsWith('/')) return unclear(`runs env with ${program.replaceAll(UNREAD, '${…}')} after its assignments, which systemctl's unquoted text cannot tell from the rest of a value with a space in it`);
    argv = argv.slice(i);
  }
  const out: UnitText = { ...u, argv, env };
  if (fixed) out.fixed = fixed;
  return out;
}

/**
 * The environment of a running process of this user's, as Linux shows it in /proc/<pid>/environ: what
 * its program was given when it was started, which is what termd read; or why it cannot be read, and
 * whether the process is then this user's and alive. Whose a process is is its real uid in
 * /proc/<pid>/status: its /proc entries belong to root while it is not dumpable, though it is still this
 * user's, and its environment then reads EACCES. Such a termd is alive and unreadable, so what it was
 * given is unknown: read from the manager's instead, it was taken for what the unit's restart would take
 * (the house's review of 4f4c067..a8b6f28, #22 comment 6323055715). A process that has gone, a pid
 * another user's after reuse, a zombie or one showing no environment is the unit's termd no more, or
 * was started with none, and reads as not alive: the unit's text is what its restart takes.
 */
export function procEnviron(pid: number): { env: Record<string, string> } | { error: string; alive: boolean } {
  const fault = (e: unknown) => {
    const code = (e as NodeJS.ErrnoException).code;
    // ESRCH: it exited between the open and the read.
    return code === 'ENOENT' || code === 'ESRCH' ? { error: 'it has gone', alive: false } : { error: code ?? (e as Error).message, alive: true };
  };
  let status: string;
  try {
    status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch (e) {
    return fault(e);
  }
  if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== process.getuid?.()) return { error: "it is another user's process", alive: false };
  if (/^State:\s+Z/m.test(status)) return { error: 'it has exited', alive: false };
  try {
    const text = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    if (!text) return { error: 'it shows no environment', alive: false };
    return { env: parseEnvNul(text) };
  } catch (e) {
    return fault(e);
  }
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
 * listens on 4100 (the house's read of the 33 commits, #22 comment 6307350861). Unknown when the
 * unit names the flag without a value, which termd refuses: read on, `--port` with TSM_PORT=4100 was
 * port 4100 and `--port=` port 3101 (the house's read of the 40 commits, #22); and without the flag
 * when the environment has a source not read here (see `systemctlUnit`). The value is read as termd
 * reads it, trimmed and as a number, so `03101` and ` 3101` are port 3101; compared as written, they
 * were another port than the shim's 3101 (the house's read of the 40 commits over our fixes, #22). A
 * value termd refuses, not digits or past 65535, is unknown, as a flag without one is.
 */
export function unitPort(u: UnitText): string | Unknown {
  if (u.unclear) return { unknown: u.unclear };
  const arg = unitArg(u, '--port');
  if (arg === null) return { unknown: 'names --port without a value' };
  let value = arg;
  if (value === undefined) {
    const tsm = fromEnv(u, 'TSM_PORT');
    const v1x = tsm === undefined ? fromEnv(u, 'SESSION_SERVER_PORT') : undefined;
    if (tsm === UNREAD || v1x === UNREAD) return { unknown: `names no --port and reads ${u.unreadEnv}, which may set TSM_PORT or SESSION_SERVER_PORT` };
    value = tsm ?? v1x ?? '3101';
  }
  if (value.includes(UNREAD)) return { unknown: `gives the port a value ${u.unreadEnv} may set` };
  const digits = value.trim();
  const n = /^\d+$/.test(digits) ? Number(digits) : NaN;
  return n <= 65535 ? String(n) : { unknown: `gives the port ${JSON.stringify(value)}, which termd refuses` };
}

/**
 * The data dir a unit's termd uses: `--data-dir`, else TSM_DATA_DIR in its environment (empty is
 * unset, as for termd), else termd's default; unknown when the unit names the flag without a value,
 * since nothing then says which dir it is, or names no flag and has an environment source not read
 * here (see `systemctlUnit`). termd resolves the value from its working
 * directory, the $HOME the unit's environment gives it (the launcher starts there), and expands nothing,
 * so neither does this: a supervisor's own expansions are made where its text is read (systemctlUnit).
 * Expanded here, a unit's `--data-dir ~/x` read as $HOME/x while termd used $HOME/~/x, since neither
 * systemd nor launchd expands `~` (the house's read of the 40 commits, #22). The home is the unit's,
 * else this shim's: taken from this shim alone, a unit setting Environment=HOME was read in another
 * directory than its termd's, and a shim run under another HOME refused a start against its own data
 * dir (the house's read of the 40 commits over our fixes, #22).
 */
export function unitDataDir(u: UnitText): string | Unknown {
  if (u.unclear) return { unknown: u.unclear };
  const arg = unitArg(u, '--data-dir');
  if (arg === null) return { unknown: 'names --data-dir without a value' };
  const named = arg ?? fromEnv(u, 'TSM_DATA_DIR');
  if (arg === undefined && named === UNREAD) return { unknown: `names no --data-dir and reads ${u.unreadEnv}, which may set TSM_DATA_DIR` };
  if (named?.includes(UNREAD)) return { unknown: `gives the data dir a value ${u.unreadEnv} may set` };
  if (named !== undefined && path.isAbsolute(named)) return path.resolve(named);
  // A relative data dir, or the default, is taken from the home the launcher starts in.
  const home = fromEnv(u, 'HOME');
  if (home === UNREAD || home?.includes(UNREAD)) return { unknown: `gives a data dir taken from $HOME, which ${u.unreadEnv} may set` };
  return path.resolve(home ?? os.homedir(), named ?? '.tsm');
}

/** A variable termd reads, as setting() reads it; UNREAD when an unread EnvironmentFile= may set it and no `env` prefix does. */
function fromEnv(u: UnitText, name: string): string | undefined {
  if (u.unreadEnv && u.fixed !== 'all' && !u.fixed?.has(name)) return UNREAD;
  return setting(name, u.env);
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
  return throughEnv({ argv, env });
}

/** Whether two paths name one directory: by what they resolve to on disk where they exist, else by their spelling. */
export function sameDir(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * What a unit's next start takes beside its running termd, to be compared with a start here as the running
 * termd's port and data dir are: the port and data dir the unit's text gives now, and why the text is taken
 * for one that may differ from what the running termd was started with. `changed` is what systemd or the
 * files say (a daemon-reload pending, a unit file or drop-in newer than the termd's start); without it, a
 * text that names another port or data dir than the running termd's has changed all the same, and says so
 * (`certain`). Read only on that evidence, a drop-in removed and then reloaded, or a text changed with no
 * newer file (a file copied with its times kept, a package's install, a manager environment set or imported
 * since), left the text unread, and a start here went ahead into the collision the unit's next start would
 * meet (a reviewer's read of the fixes for #22). Undefined when nothing says the text differs: no evidence,
 * and the text names what runs, or cannot tell it, or cannot be read.
 */
export function nextStart(running: { port: string; dataDir: string }, text: UnitText | { why: string }, changed: string): NextStart | undefined {
  if ('why' in text) return changed ? { why: changed, certain: false, port: { unknown: `could not be read (${text.why})` }, dataDir: { unknown: `could not be read (${text.why})` } } : undefined;
  const port = unitPort(text);
  const dataDir = unitDataDir(text);
  if (changed) return { why: changed, certain: false, port, dataDir };
  if (typeof port === 'string' && port !== running.port) return { why: `it names port ${port}, which differs from its running termd's port ${running.port}`, certain: true, port, dataDir };
  if (typeof dataDir === 'string' && !sameDir(dataDir, running.dataDir)) return { why: `it names the data dir ${dataDir}, which differs from its running termd's ${running.dataDir}`, certain: true, port, dataDir };
  return undefined;
}

/** See nextStart: the port and data dir a unit's next start takes, each unknown where the text cannot tell it. */
export interface NextStart {
  why: string;
  /** The text is known to differ from what the running termd was started with, not only said to have possibly changed. */
  certain: boolean;
  port: string | Unknown;
  dataDir: string | Unknown;
}
