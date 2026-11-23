// Filesystem and path helpers are the only imports.
// Everything else is plain syntax, so the entry stays small
// and needs no package install.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// Accepted --format names; auto means sniff the patch.
// Only these values are allowed so a typo becomes a usage
// error instead of silently selecting some parser.
const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

// Exit2 carries the single stdout line for a parse or usage failure.
// It unwinds out of a parser without writing, so a bad patch never
// touches the working tree.
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
// Fail records one edit's rejected path and reason code.
// Collecting them instead of throwing keeps the patch all-or-nothing
// while still reporting every bad edit individually.
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// Blank means whitespace only.
// Parsers use it to skip padding and to find the first real line.
const blank = (s: string): boolean => s.trim() === '';

// Split the patch into records for LF or CRLF input.
// A terminal newline only ends the last record, so it never adds
// a phantom empty one. Each line keeps its text but drops the
// trailing CR, giving every parser a single shape to read.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

// A path is safe when it is relative, uses forward slashes, and has
// no empty, dot, or dot-dot segment. That keeps writes inside the
// working directory.
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
// The tree overlays pending edits on the working directory.
// original() memoizes the on-disk bytes exactly once, while now()
// holds staged text and tombstone nulls. Keeping one snapshot avoids
// repeated stat calls and lets later edits see earlier results.
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  readonly now = new Map<string, string | null>();
  // Read p from disk exactly once and memoize it as text or null.
  // A non-file or stat/read error records null so a later get() can
  // treat it as absent without retrying; the cache also fixes the
  // baseline the final report compares against.
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let content: string | null = null;
      try {
        if (statSync(p).isFile()) content = readFileSync(p, 'utf8');
      } catch {
        content = null;
      }
      this.orig.set(p, content);
    }
    return this.orig.get(p)!;
  }
  // The staged view: pending text if an earlier edit wrote p,
  // otherwise the memoized on-disk baseline. A null means the path
  // is currently deleted, so later edits see preceding results.
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

// An edit is deferred until its turn, so path checks and content
// transforms run against the tree exactly as preceding edits leave it.
type Edit = (tree: Tree) => void;

// Detect the format by its signature: `*** Begin Patch` means v4a, a
// leading `[` or `{` means json, a `<<<<<<< SEARCH` line means
// search-replace, and `diff --git ` or `--- ` before `+++ ` means
// unified. When none of the four holds, auto yields null for the caller.
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

// Validate one JSON command object and return its deferred edit.
// A non-object, a missing string path, or an unknown shape returns
// null so the caller can blame the correct line. Bodies are captured
// now and only applied later against the staged tree.
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const cmd = v as Record<string, unknown>;
  const p = cmd.path;
  if (typeof p !== 'string') return null;
  if (cmd.command === 'create' && typeof cmd.file_text === 'string') {
    const text = cmd.file_text;
    return fileEdit(null, p, () => text);
  }
  if (cmd.command === 'str_replace' && typeof cmd.old_str === 'string' && cmd.old_str !== '' && (cmd.new_str === undefined || typeof cmd.new_str === 'string')) {
    const oldStr = cmd.old_str;
    const newStr = (cmd.new_str as string | undefined) ?? '';
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
  if (cmd.command === 'insert' && typeof cmd.insert_line === 'number' && Number.isInteger(cmd.insert_line) && typeof cmd.new_str === 'string') {
    const line = cmd.insert_line;
    const inserted = patchLines(cmd.new_str);
    return fileEdit(p, p, (before) => {
      const { lines, br, final } = splitFile(before);
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      return joinFile(lines.slice(0, line).concat(inserted, lines.slice(line)), br, final);
    });
  }
  return null;
}

// Parse either a whole JSON array or one command per nonblank line.
// Array failures point at the opening line while per-line records
// blame their own line. Each command is validated before the next is
// read, so the first bad record decides the outcome.
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(document)) throw new Exit2(`error: parse ${first + 1}`);
    for (const command of document) {
      const built = jsonEdit(command);
      if (built === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(built);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let built: Edit | null = null;
    try {
      built = jsonEdit(JSON.parse(l));
    } catch {
      built = null;
    }
    if (built === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(built);
  });
  return edits;
}

// Turn a zero-based parser position into the published parse error
// and abort at once; every parser funnels bad structure here.
function parseFault(index: number): never {
  throw new Exit2(`error: parse ${index + 1}`);
}

// Pick the file's newline style from its first break.
// With no break at all it falls back to LF.
function lineBreak(text: string): string {
  const first = text.indexOf('\n');
  return first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
}

// Split a file into lines plus the facts needed to rebuild it: its
// newline style and whether it ended with one. The empty tail entry
// left by a final break is removed.
function splitFile(text: string) {
  const br = lineBreak(text);
  const lines = text === '' ? [] : text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

// Rebuild text from lines using the given break and final-newline
// flag. An empty list stays empty so creates and deletes round-trip.
function joinFile(lines: string[], br = '\n', final = true): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

// A replacement supplies text, copies a context line, or suppresses
// the trailing break. The tier table normalizes exactly, then without
// trailing space, then without indentation; matching loosens in that
// order while stored text is never rewritten.
type Replacement = { text: string; context?: number; noBreak?: boolean };
type LineEdit = { old: string[]; next: Replacement[] };
// A fresh, empty block: no expected old lines and no replacement
// lines. Parsers grow both sides as they read body markers.
const emptyLineEdit = (): LineEdit => ({ old: [], next: [] });
// The leading spaces or tabs of a line, used to reindent loose
// matches. The anchored pattern always matches, even when empty.
const indent = (line: string): string => /^[ \t]*/.exec(line)![0];
// Strip trailing spaces and tabs so the middle matching tier can
// ignore insignificant padding at line ends.
const trimTail = (line: string): string => line.replace(/[ \t]+$/, '');
// Exact, then ignore trailing space, then also ignore leading
// indentation. matchLines walks these strictest first and stops
// at the first tier with a hit.
const matchingTiers = [(line: string) => line, trimTail, (line: string) => trimTail(line).replace(/^[ \t]+/, '')];

// Scan the inclusive start..end window for the whole old block.
// Tiers run strictest first and stop at the first that matches, so a
// relaxed tier only wins when nothing tighter did. Every position in
// that winning tier is returned for the caller to disambiguate.
function matchLines(lines: string[], old: string[], strict: boolean, start = 0, end = lines.length - old.length) {
  for (let tier = 0; tier < (strict ? 1 : matchingTiers.length); tier++) {
    const normalize = matchingTiers[tier]!;
    const expected = old.map(normalize);
    const positions: number[] = [];
    const candidates = tier === 0 ? lines : lines.map(normalize);
    for (let pos = start; pos <= end; pos++) {
      if (expected.every((line, index) => line === candidates[pos + index])) positions.push(pos);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return undefined;
}

// Splice the replacement in at the chosen position.
// Context lines are copied verbatim from the file, and a loose match
// reindents additions to the found line's indent so the result fits
// the file rather than the patch.
function replaceLines(lines: string[], edit: LineEdit, at: number, tier: number): string[] {
  const from = tier === 2 ? indent(edit.old[0]!) : '';
  const to = tier === 2 ? indent(lines[at]!) : '';
  const replacement = edit.next.map(({ text, context }) => {
    if (context !== undefined) return lines[at + context]!;
    return tier === 2 && !blank(text) && text.startsWith(from) ? to + text.slice(from.length) : text;
  });
  return lines.slice(0, at).concat(replacement, lines.slice(at + edit.old.length));
}

// Read one body line by its marker: plus appends new text, space
// copies a context line, and anything else is old text. The context
// index refers to the old block so the copied line lands correctly.
function addBodyLine(edit: LineEdit, line: string): void {
  const marker = line[0] ?? ' ';
  const text = line.slice(1);
  if (marker === '+') edit.next.push({ text });
  else {
    if (marker === ' ') edit.next.push({ text, context: edit.old.length });
    edit.old.push(text);
  }
}

// Wrap a transform in the shared edit protocol.
// Paths are validated, the source must exist, and a create or move
// destination must be free against the staged tree. The output is
// then staged and any move recorded for the final report.
function fileEdit(
  oldPath: string | null,
  newPath: string | null,
  transform: (text: string) => string,
  namedPaths: string[] = [oldPath, newPath].filter((p): p is string => p !== null),
  move = oldPath !== null && newPath !== null && oldPath !== newPath,
): Edit {
  return (tree) => {
    for (const p of namedPaths) if (!safe(p)) throw new Fail('unsafe', p);
    const source = oldPath === null ? '' : tree.get(oldPath);
    if (source === null) throw new Fail('missing', oldPath!);
    if (newPath !== null && (oldPath === null || move) && tree.get(newPath) !== null) {
      throw new Fail('exists', newPath);
    }
    const result = newPath === null ? null : transform(source);
    if (oldPath !== null && (newPath === null || move)) tree.now.set(oldPath, null);
    if (newPath !== null) tree.now.set(newPath, result);
    if (move) tree.moves.push([oldPath!, newPath!]);
  };
}

// Resolve each SEARCH block's path before reading its bodies.
// The path may carry over from the previous block; an empty search
// creates the file, while a nonempty one must match uniquely.
// Parsing stops at the first malformed block.
function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const markerLines = lines.map((line) => line.trimEnd());
  let previousEnd = -1;
  let previousPath: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (markerLines[i] !== '<<<<<<< SEARCH') continue;
    let path = previousPath;
    for (let scan = i - 1; scan > previousEnd; scan--) {
      const header = lines[scan]!.trim();
      if (header && !header.startsWith('```')) {
        path = header;
        break;
      }
    }
    const separator = markerLines.indexOf('=======', i + 1);
    const end = separator < 0 ? -1 : markerLines.indexOf('>>>>>>> REPLACE', separator + 1);
    if (path === undefined || end < 0) parseFault(i);
    const file = path;
    const old = lines.slice(i + 1, separator);
    const next = lines.slice(separator + 1, end).map((text) => ({ text }));
    edits.push(fileEdit(old.length === 0 ? null : file, file, (text) => {
      if (old.length === 0) return joinFile(next.map((line) => line.text));
      const { lines, br, final } = splitFile(text);
      const match = matchLines(lines, old, strict);
      if (!match) throw new Fail('no-match', file);
      if (match.positions.length !== 1) throw new Fail('ambiguous', file);
      return joinFile(replaceLines(lines, { old, next }, match.positions[0]!, match.tier), br, final);
    }));
    previousPath = file;
    previousEnd = i = end;
  }
  return edits;
}

// A hunk adds an expected start line to a line edit. A section
// collects one file's headers, move metadata, create/delete flags,
// and hunks before it is turned into an edit.
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

// Turn one parsed section into a single edit.
// Creates emit only added lines, deletes empty the file, and updates
// shift each hunk's expected start by the prior net change. The
// nearest match is chosen so accumulated drift cannot misfire.
function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const { paths, git, renameFrom, renameTo, hunks } = section;
  const old = paths ? paths[0] : renameFrom ?? git?.[0] ?? null;
  const destination = paths ? paths[1] : renameTo ?? git?.[1] ?? null;
  const namedPaths = [old, destination].filter((p): p is string => p !== null);
  if (old === null || section.create) {
    const added = hunks.flatMap((hunk) => hunk.next.filter((line) => line.context === undefined));
    return fileEdit(null, destination, () => joinFile(added.map((line) => line.text), '\n', !added.at(-1)?.noBreak), namedPaths);
  }
  if (destination === null || section.delete) return fileEdit(old, null, () => '', namedPaths);

  return fileEdit(old, destination, (text) => {
    const { lines: original, br, final: ended } = splitFile(text);
    let lines = original;
    let final = ended;
    let drift = 0n;
    for (const hunk of hunks) {
      const expected = hunk.start + drift;
      let pos: number;
      let tier = 0;
      if (hunk.old.length === 0) {
        pos = expected < 0n ? 0 : expected > BigInt(lines.length) ? lines.length : Number(expected);
      } else {
        const match = matchLines(lines, hunk.old, strict);
        if (!match) throw new Fail('no-match', old);
        tier = match.tier;
        const target = expected - 1n;
        // Unsigned distance from a candidate position to the
        // header's expected start, so the nearest match wins after
        // accumulated line drift.
        const distance = (position: number): bigint => {
          const delta = BigInt(position) - target;
          return delta < 0n ? -delta : delta;
        };
        pos = match.positions.reduce((best, candidate) => distance(candidate) < distance(best) ? candidate : best);
      }
      if (pos + hunk.old.length === lines.length) final = !hunk.next.at(-1)?.noBreak;
      lines = replaceLines(lines, hunk, pos, tier);
      drift += BigInt(hunk.next.length - hunk.old.length);
    }
    return joinFile(lines, br, final);
  }, namedPaths);
}

// Group headers, metadata, and hunks into sections.
// Body lines are read from their markers so stale header counts do
// not matter. Each marker or stray header closes the section in
// progress and opens the next one.
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let section: UnifiedSection | undefined;
  // A --- header only counts with its +++ mate directly below it,
  // which keeps stray body dashes from closing the current hunk.
  const isHeaderPair = (i: number) => lines[i]?.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');
  // Take the path from a ---/+++ header, dropping any tab timestamp
  // and the a/ or b/ prefix. /dev/null becomes null for creates and
  // deletes.
  const readHeaderPath = (line: string) => {
    const path = line.slice(4).split('\t', 1)[0]!.trim();
    return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
  };
  // Emit the section in progress, if any, before a new header or
  // marker starts the next one. The null check skips empty runs.
  const finishSection = () => {
    if (section) edits.push(unifiedEdit(section, strict));
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!gitHeader) parseFault(i);
      finishSection();
      section = { git: [gitHeader[1]!, gitHeader[2]!], hunks: [] };
    } else if (isHeaderPair(i)) {
      if (!section?.git || section.paths || section.hunks.length > 0) {
        finishSection();
        section = { hunks: [] };
      }
      section.paths = [readHeaderPath(line), readHeaderPath(lines[++i]!)];
    } else if (line.startsWith('@@')) {
      const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!hunkHeader || !section) parseFault(i);
      const start = ++i;
      while (i < lines.length && !isHeaderPair(i) && (lines[i] === '' || /^[ +\\-]/.test(lines[i]!))) i++;
      let bodyEnd = i;
      while (bodyEnd > start && lines[bodyEnd - 1] === '') bodyEnd--;
      const hunk: Hunk = { ...emptyLineEdit(), start: BigInt(hunkHeader[1]!) };
      let previous: Replacement | undefined;
      for (let scan = start; scan < bodyEnd; scan++) {
        const body = lines[scan]!;
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

// A V4A chunk carries an optional anchor line and an end-of-file flag.
// The header pattern names the three operations, and the move header
// marks a rename target for an update.
type Chunk = LineEdit & { anchor: string; eof: boolean };
const v4aHeader = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
const moveHeader = '*** Move to: ';

// Parse the enclosed V4A operations between Begin and End.
// Adds collect plus lines, deletes must be bodyless, and updates
// apply chunks in order while the cursor advances past each one.
// Anchors position a chunk and End of File pins the tail.
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
    const marker = i;
    const header = v4aHeader.exec(lines[i++]!);
    if (!header) parseFault(marker);
    const [, operation, rawPath] = header;
    const path = rawPath!.trim();
    let end = i;
    while (end < last && !v4aHeader.test(lines[end]!)) end++;
    let blockEnd = end;
    while (blockEnd > i && blank(lines[blockEnd - 1]!)) blockEnd--;
    if (operation === 'Add') {
      const added: string[] = [];
      for (; i < blockEnd; i++) {
        const line = lines[i]!;
        if (line !== '' && !line.startsWith('+')) parseFault(i);
        added.push(line.slice(1));
      }
      edits.push(fileEdit(null, path, () => joinFile(added)));
    } else if (operation === 'Delete') {
      if (i < blockEnd) parseFault(i);
      edits.push(fileEdit(path, null, () => ''));
    } else {
      const hasMove = i < blockEnd && lines[i]!.startsWith(moveHeader);
      const destination = hasMove ? lines[i++]!.slice(moveHeader.length).trim() : path;
      const chunks: Chunk[] = [];
      let chunk: Chunk | undefined;
      for (; i < blockEnd; i++) {
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
      if (chunks.length === 0 && !hasMove) parseFault(marker);
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
          let insertAt = chunk.eof ? lines.length : cursor;
          let tier = 0;
          if (chunk.old.length > 0) {
            const match = matchLines(lines, chunk.old, strict, chunk.eof ? Math.max(cursor, end) : cursor, end);
            if (!match) throw new Fail('no-match', path);
            insertAt = match.positions[0]!;
            tier = match.tier;
          }
          lines = replaceLines(lines, chunk, insertAt, tier);
          cursor = insertAt + chunk.next.length;
        }
        return joinFile(lines, br, final);
      }, [path, destination], hasMove));
    }
    i = end;
  }
  return edits;
}

// Read the CLI arguments, then parse and stage the patch edits.
// Positional choice, format, and mode flags are settled before any
// reading. Only a clean run outside dry-run mode commits the tree;
// every failure path leaves the working directory untouched.
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let dryRun = false;
  let strict = false;
  const positional: string[] = [];
  let ended = false;
  for (const arg of args) {
    if (!ended && arg === '--') ended = true;
    else if (!ended && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && format === null && FORMATS.includes(arg.slice(9))) format = arg.slice(9);
      else if (arg === '--check' && !dryRun) dryRun = true;
      else if (arg === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else positional.push(arg);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchPath = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let source = '';
  try {
    source = readFileSync(patchPath ?? 0, 'utf8');
  } catch {
    if (patchPath !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const patch = patchLines(source);
  const chosen = format === null || format === 'auto' ? detect(patch) : format;
  if (chosen === null) return { code: 2, out: ['error: format'] };
  let staged: Edit[];
  try {
    switch (chosen) {
      case 'json': staged = jsonEdits(source, patch); break;
      case 'unified': staged = unifiedEdits(patch, strict); break;
      case 'search-replace': staged = searchEdits(patch, strict); break;
      case 'v4a': staged = v4aEdits(patch, strict); break;
      default: throw new Error(`Unexpected format: ${chosen}`);
    }
    if (staged.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const work = new Tree();
  const rejections: Fail[] = [];
  for (const edit of staged) {
    try {
      edit(work);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      rejections.push(e);
    }
  }
  if (rejections.length > 0) return { code: 1, out: [...rejections.map((f) => `error: ${f.code} ${f.path}`), `failed: ${rejections.length} of ${staged.length} edits`] };
  const states = new Map<string, string>();
  const touched = [...work.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of touched) {
    const before = work.original(p);
    const after = work.now.get(p)!;
    if (before !== after) states.set(p, before === null ? 'A' : after === null ? 'D' : 'M');
  }
  const moved = new Map<string, string>();
  for (const [old, to] of work.moves) {
    if (states.get(old) === 'D' && states.get(to) === 'A' && !moved.has(to)) {
      states.delete(old);
      moved.set(to, old);
    }
  }
  const summary = [...states].map(([p, state]) => moved.has(p) ? `R ${moved.get(p)} -> ${p}` : `${state} ${p}`);
  if (!dryRun) {
    // Remove old files first so a later edit can reuse their paths as directories.
    for (const p of touched) {
      if (work.now.get(p) === null && work.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of touched) {
      const after = work.now.get(p)!;
      if (after === null || after === work.original(p)) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, after);
    }
  }
  return { code: 0, out: [...summary, `ok: ${summary.length} ${summary.length === 1 ? 'file' : 'files'}`] };
}


// Inside the kit a trial URL is exported, so hand control to runner.ts.
// Otherwise run once over argv, print the result lines, and derive the
// exit code from them. Failures already arrive as stdout text, so this
// hand-over stays thin.
const trialUrl = process.env.MAKEFUN_ENV_URL;
if (trialUrl !== undefined && trialUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialUrl);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
