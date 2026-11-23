import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

// Normalize patch records from LF or CRLF input.
// A terminal newline ends the last record without adding an empty one.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// Use the first nonblank line for V4A and JSON signatures.
// Search the whole patch for SEARCH markers and unified headers.
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const initial = lines[first]!.trimStart()[0];
  if (initial === '[' || initial === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// Validate one JSON command and build its deferred edit.
// Invalid command objects return null for the parser to report.
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return fileEdit(null, p, () => text);
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return fileEdit(p, p, (before) => {
      const crlf = lineBreak(before) === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      const at = t.indexOf(old);
      if (at < 0) throw new Fail('no-match', p);
      if (t.indexOf(old, at + 1) >= 0) throw new Fail('ambiguous', p);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      return crlf ? out.replaceAll('\n', '\r\n') : out;
    });
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const inserted = patchLines(o.new_str);
    return fileEdit(p, p, (before) => {
      const { lines, br, final } = splitFile(before);
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      return joinFile(lines.slice(0, line).concat(inserted, lines.slice(line)), br, final);
    });
  }
  return null;
}

// Parse either an array of commands or one command per nonblank line.
// Array errors point to the opening line, while individual records report their own line.
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const command of v) {
      const e = jsonEdit(command);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function parseFault(index: number): never {
  throw new Exit2(`error: parse ${index + 1}`);
}

function lineBreak(text: string): string {
  const first = text.indexOf('\n');
  return first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
}

function splitFile(text: string) {
  const br = lineBreak(text);
  const lines = text === '' ? [] : text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br = '\n', final = true): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

type Replacement = { text: string; context?: number; noBreak?: boolean };
type LineEdit = { old: string[]; next: Replacement[] };
const emptyLineEdit = (): LineEdit => ({ old: [], next: [] });
const indent = (line: string): string => /^[ \t]*/.exec(line)![0];
const trimTail = (line: string): string => line.replace(/[ \t]+$/, '');
const matchingTiers = [(line: string) => line, trimTail, (line: string) => trimTail(line).replace(/^[ \t]+/, '')];

// Try the matching tiers in order within the inclusive start range.
// Return every position in the first tier that produces a match.
function matchLines(lines: string[], old: string[], strict: boolean, start = 0, end = lines.length - old.length) {
  for (let tier = 0; tier < (strict ? 1 : matchingTiers.length); tier++) {
    const normalize = matchingTiers[tier]!;
    const expected = old.map(normalize);
    const positions: number[] = [];
    const candidates = tier === 0 ? lines : lines.map(normalize);
    for (let at = start; at <= end; at++) {
      if (expected.every((line, index) => line === candidates[at + index])) positions.push(at);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return undefined;
}

// Copy context from the file to preserve its whitespace.
// For indentation-insensitive matches, reindent additions to fit the match.
function replaceLines(lines: string[], edit: LineEdit, at: number, tier: number): string[] {
  const from = tier === 2 ? indent(edit.old[0]!) : '';
  const to = tier === 2 ? indent(lines[at]!) : '';
  const replacement = edit.next.map(({ text, context }) => {
    if (context !== undefined) return lines[at + context]!;
    return tier === 2 && !blank(text) && text.startsWith(from) ? to + text.slice(from.length) : text;
  });
  return lines.slice(0, at).concat(replacement, lines.slice(at + edit.old.length));
}

function addBodyLine(edit: LineEdit, line: string): void {
  const marker = line[0] ?? ' ';
  const text = line.slice(1);
  if (marker === '+') edit.next.push({ text });
  else {
    if (marker === ' ') edit.next.push({ text, context: edit.old.length });
    edit.old.push(text);
  }
}

// Check paths against the tree produced by preceding edits.
// Stage the resulting content and record moves for the final report.
function fileEdit(
  oldPath: string | null,
  newPath: string | null,
  transform: (text: string) => string,
  namedPaths: string[] = [oldPath, newPath].filter((p): p is string => p !== null),
  move = oldPath !== null && newPath !== null && oldPath !== newPath,
): Edit {
  return (tree) => {
    for (const p of namedPaths) if (!safe(p)) throw new Fail('unsafe', p);
    const before = oldPath === null ? '' : tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath!);
    if (newPath !== null && (oldPath === null || move) && tree.get(newPath) !== null) {
      throw new Fail('exists', newPath);
    }
    const updated = newPath === null ? null : transform(before);
    if (oldPath !== null && (newPath === null || move)) tree.now.set(oldPath, null);
    if (newPath !== null) tree.now.set(newPath, updated);
    if (move) tree.moves.push([oldPath!, newPath!]);
  };
}

// Resolve each SEARCH block's path before reading its two bodies.
// An empty search creates a file, while a nonempty search requires a unique match.
function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const markerLines = lines.map((line) => line.trimEnd());
  let previousEnd = -1;
  let previousPath: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (markerLines[i] !== '<<<<<<< SEARCH') continue;
    let path = previousPath;
    for (let at = i - 1; at > previousEnd; at--) {
      const candidate = lines[at]!.trim();
      if (candidate && !candidate.startsWith('```')) {
        path = candidate;
        break;
      }
    }
    const separator = markerLines.indexOf('=======', i + 1);
    const end = separator < 0 ? -1 : markerLines.indexOf('>>>>>>> REPLACE', separator + 1);
    if (path === undefined || end < 0) parseFault(i);
    const p = path;
    const old = lines.slice(i + 1, separator);
    const next = lines.slice(separator + 1, end).map((text) => ({ text }));
    edits.push(fileEdit(old.length === 0 ? null : p, p, (text) => {
      if (old.length === 0) return joinFile(next.map((line) => line.text));
      const { lines, br, final } = splitFile(text);
      const match = matchLines(lines, old, strict);
      if (!match) throw new Fail('no-match', p);
      if (match.positions.length !== 1) throw new Fail('ambiguous', p);
      return joinFile(replaceLines(lines, { old, next }, match.positions[0]!, match.tier), br, final);
    }));
    previousPath = p;
    previousEnd = i = end;
  }
  return edits;
}

type Hunk = LineEdit & { start: bigint };
type UnifiedSection = {
  git?: [string, string];
  paths?: [string | null, string | null];
  renameFrom?: string;
  renameTo?: string;
  create?: boolean;
  delete?: boolean;
  hunks: Hunk[];
};

// Convert a parsed unified section into one file edit.
// Offset each hunk's expected position by the preceding hunks' net line change.
function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const { paths, git, renameFrom, renameTo, hunks } = section;
  const old = paths ? paths[0] : renameFrom ?? git?.[0] ?? null;
  const next = paths ? paths[1] : renameTo ?? git?.[1] ?? null;
  const namedPaths = [old, next].filter((p): p is string => p !== null);
  if (old === null || section.create) {
    const added = hunks.flatMap((hunk) => hunk.next.filter((line) => line.context === undefined));
    return fileEdit(null, next, () => joinFile(added.map((line) => line.text), '\n', !added.at(-1)?.noBreak), namedPaths);
  }
  if (next === null || section.delete) return fileEdit(old, null, () => '', namedPaths);

  return fileEdit(old, next, (text) => {
    const { lines: original, br, final: ended } = splitFile(text);
    let lines = original;
    let final = ended;
    let drift = 0n;
    for (const hunk of hunks) {
      const expected = hunk.start + drift;
      let at: number;
      let tier = 0;
      if (hunk.old.length === 0) {
        at = expected < 0n ? 0 : expected > BigInt(lines.length) ? lines.length : Number(expected);
      } else {
        const match = matchLines(lines, hunk.old, strict);
        if (!match) throw new Fail('no-match', old);
        tier = match.tier;
        const target = expected - 1n;
        const distance = (position: number): bigint => {
          const delta = BigInt(position) - target;
          return delta < 0n ? -delta : delta;
        };
        at = match.positions.reduce((best, candidate) => distance(candidate) < distance(best) ? candidate : best);
      }
      if (at + hunk.old.length === lines.length) final = !hunk.next.at(-1)?.noBreak;
      lines = replaceLines(lines, hunk, at, tier);
      drift += BigInt(hunk.next.length - hunk.old.length);
    }
    return joinFile(lines, br, final);
  }, namedPaths);
}

// Group file headers, metadata, and hunks into unified sections.
// Read hunk bodies from their line markers, allowing stale header counts.
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let section: UnifiedSection | undefined;
  const pairAt = (i: number) => lines[i]?.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');
  const headerPath = (line: string) => {
    const path = line.slice(4).split('\t', 1)[0]!.trim();
    return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
  };
  const finishSection = () => {
    if (section) edits.push(unifiedEdit(section, strict));
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!header) parseFault(i);
      finishSection();
      section = { git: [header[1]!, header[2]!], hunks: [] };
    } else if (pairAt(i)) {
      if (!section?.git || section.paths || section.hunks.length > 0) {
        finishSection();
        section = { hunks: [] };
      }
      section.paths = [headerPath(line), headerPath(lines[++i]!)];
    } else if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!header || !section) parseFault(i);
      const start = ++i;
      while (i < lines.length && !pairAt(i) && (lines[i] === '' || /^[ +\\-]/.test(lines[i]!))) i++;
      let end = i;
      while (end > start && lines[end - 1] === '') end--;
      const hunk: Hunk = { ...emptyLineEdit(), start: BigInt(header[1]!) };
      let previous: Replacement | undefined;
      for (let at = start; at < end; at++) {
        const body = lines[at]!;
        if (body.startsWith('\\')) {
          if (previous) previous.noBreak = true;
          previous = undefined;
        } else {
          addBodyLine(hunk, body);
          previous = body.startsWith('-') ? undefined : hunk.next.at(-1);
        }
      }
      section.hunks.push(hunk);
      continue;
    } else if (section && section.hunks.length === 0) {
      if (line.startsWith('--- ')) parseFault(i + 1);
      if (line.startsWith('rename from ')) section.renameFrom = line.slice(12).trim();
      if (line.startsWith('rename to ')) section.renameTo = line.slice(10).trim();
      if (/^new file mode(?: |$)/.test(line)) section.create = true;
      if (/^deleted file mode(?: |$)/.test(line)) section.delete = true;
    }
    i++;
  }
  finishSection();
  return edits;
}

type Chunk = LineEdit & { anchor: string; eof: boolean };
const v4aHeader = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
const moveHeader = '*** Move to: ';

// Parse the enclosed V4A file operations.
// Apply update chunks in order, advancing past each replacement.
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parseFault(Math.max(first, 0));
  let last = lines.length - 1;
  while (blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') parseFault(lines.length);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const start = i;
    const header = v4aHeader.exec(lines[i++]!);
    if (!header) parseFault(start);
    const [, kind, rawPath] = header;
    const path = rawPath!.trim();
    let end = i;
    while (end < last && !v4aHeader.test(lines[end]!)) end++;
    let bodyEnd = end;
    while (bodyEnd > i && blank(lines[bodyEnd - 1]!)) bodyEnd--;
    if (kind === 'Add') {
      const added: string[] = [];
      for (; i < bodyEnd; i++) {
        const line = lines[i]!;
        if (line !== '' && !line.startsWith('+')) parseFault(i);
        added.push(line.slice(1));
      }
      edits.push(fileEdit(null, path, () => joinFile(added)));
    } else if (kind === 'Delete') {
      if (i < bodyEnd) parseFault(i);
      edits.push(fileEdit(path, null, () => ''));
    } else {
      const hasMove = i < bodyEnd && lines[i]!.startsWith(moveHeader);
      const destination = hasMove ? lines[i++]!.slice(moveHeader.length).trim() : path;
      const chunks: Chunk[] = [];
      let chunk: Chunk | undefined;
      for (; i < bodyEnd; i++) {
        const line = lines[i]!;
        if (line.startsWith('@@') || (!chunk && chunks.length === 0 && (line === '' || /^[ +-]/.test(line)))) {
          chunk = { ...emptyLineEdit(), anchor: line.startsWith('@@') ? line.slice(2).trim() : '', eof: false };
          chunks.push(chunk);
          if (line.startsWith('@@')) continue;
        }
        if (!chunk) parseFault(i);
        if (line === '*** End of File') {
          chunk.eof = true;
          chunk = undefined;
        } else {
          if (line !== '' && !/^[ +-]/.test(line)) parseFault(i);
          addBodyLine(chunk, line);
        }
      }
      if (chunks.length === 0 && !hasMove) parseFault(start);
      edits.push(fileEdit(path, destination, (text) => {
        const { lines: original, br, final } = splitFile(text);
        let lines = original;
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor) {
            const anchor = matchLines(lines, [chunk.anchor], strict, cursor);
            if (!anchor) throw new Fail('no-match', path);
            cursor = anchor.positions[0]! + 1;
          }
          const end = lines.length - chunk.old.length;
          let at = chunk.eof ? lines.length : cursor;
          let tier = 0;
          if (chunk.old.length > 0) {
            const match = matchLines(lines, chunk.old, strict, chunk.eof ? Math.max(cursor, end) : cursor, end);
            if (!match) throw new Fail('no-match', path);
            at = match.positions[0]!;
            tier = match.tier;
          }
          lines = replaceLines(lines, chunk, at, tier);
          cursor = at + chunk.next.length;
        }
        return joinFile(lines, br, final);
      }, [path, destination], hasMove));
    }
    i = end;
  }
  return edits;
}

// Read the CLI arguments, parse the patch, and stage its edits in order.
// Write the staged changes only after validation succeeds and check mode is off.
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else positional.push(a);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const file = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    switch (kind) {
      case 'json': edits = jsonEdits(text, lines); break;
      case 'unified': edits = unifiedEdits(lines, strict); break;
      case 'search-replace': edits = searchEdits(lines, strict); break;
      case 'v4a': edits = v4aEdits(lines, strict); break;
      default: throw new Error(`Unexpected format: ${kind}`);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changes = new Map<string, string>();
  const paths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of paths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changes.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const renames = new Map<string, string>();
  for (const [old, next] of tree.moves) {
    if (changes.get(old) === 'D' && changes.get(next) === 'A' && !renames.has(next)) {
      changes.delete(old);
      renames.set(next, old);
    }
  }
  const rows = [...changes].map(([p, kind]) => renames.has(p) ? `R ${renames.get(p)} -> ${p}` : `${kind} ${p}`);
  if (!check) {
    // Remove old files first so a later edit can reuse their paths as directories.
    for (const p of paths) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of paths) {
      const now = tree.now.get(p)!;
      if (now === null || now === tree.original(p)) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
