// mend: one patch tool for every AI edit format, written to SPEC.md version 1.
// Node 22, standard library only. Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// A trial hands over to runner.ts when MAKEFUN_ENV_URL is set; that hand-over
// at the bottom of this file and runner.ts itself are kept as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class ParseFault {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

interface Doc {
  lines: string[];
  brk: string;
  eol: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], brk: '\n', eol: false };
  const idx = text.indexOf('\n');
  const brk = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  const eol = text.endsWith(brk);
  if (eol) parts.pop();
  return { lines: parts, brk, eol };
}

function serializeDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.brk) + (doc.eol ? doc.brk : '');
}

/** A created file's lines: LF breaks, a final break when there is at least one line. */
function serializeCreated(lines: string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}

/** The working tree: original bytes read from disk, pending changes in `now`. */
class Tree {
  private readonly orig = new Map<string, string | null>();
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
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

interface Edit {
  apply: (tree: Tree) => void;
  move?: { old: string; fresh: string };
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(lines: string[], old: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i += 1) {
    if (eofOnly && i + old.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

function findAtTier(lines: string[], old: string[], strict: boolean, from: number, eofOnly: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, old, t, from, eofOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NewPiece {
  text: string;
  ctxIdx: number | null;
}

/** Split body items into the old lines O and the new lines N (context pieces keep their O index). */
function splitBody(items: Array<{ kind: string; text: string }>): { oldLines: string[]; newSeg: NewPiece[] } {
  const oldLines: string[] = [];
  const newSeg: NewPiece[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      newSeg.push({ text: it.text, ctxIdx: oldLines.length });
      oldLines.push(it.text);
    } else if (it.kind === 'old') {
      oldLines.push(it.text);
    } else if (it.kind === 'new') {
      newSeg.push({ text: it.text, ctxIdx: null });
    }
  }
  return { oldLines, newSeg };
}

/** Build the replacement segment for a match, following section 5 (context lines stay the file's own). */
function buildSegment(docLines: string[], pos: number, tier: number, oldLines: string[], newSeg: NewPiece[]): string[] {
  const pfx = leadWs(oldLines[0]!);
  const ffx = leadWs(docLines[pos]!);
  return newSeg.map((piece) => {
    if (piece.ctxIdx !== null) return docLines[pos + piece.ctxIdx]!;
    if (tier !== 2) return piece.text;
    const t = piece.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(pfx)) return ffx + t.slice(pfx.length);
    return t;
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Format detection (section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
  empty: boolean;
}

interface UniHunk {
  a: number;
  items: BodyItem[];
  noEol: boolean;
}

interface UniSection {
  diffOld?: string;
  diffNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  hasPair: boolean;
  renameOld?: string;
  renameNew?: string;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: UniHunk[];
}

function freshSection(): UniSection {
  return { hasPair: false, createFlag: false, deleteFlag: false, hunks: [] };
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/.exec(line);
  if (m === null) return null;
  return Number(m[1]);
}

function parseDiffGit(line: string): [string, string] | null {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

/** Path after `--- ` / `+++ `: text after four chars, up to the first tab, spaces removed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function noEolAfterLast(items: BodyItem[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i]!.kind === 'ctx' || items[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return items[last + 1] !== undefined && items[last + 1]!.kind === 'mark';
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let state: 'outside' | 'header' | 'body' | 'after' = 'outside';
  let bodyItems: BodyItem[] = [];
  let curA = 0;
  const closeHunk = (): void => {
    if (cur === null) return;
    while (bodyItems.length > 0) {
      const last = bodyItems[bodyItems.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') bodyItems.pop();
      else break;
    }
    cur.hunks.push({ a: curA, items: bodyItems, noEol: noEolAfterLast(bodyItems) });
    bodyItems = [];
  };
  const beginSection = (sec: UniSection): void => {
    if (cur !== null) sections.push(cur);
    cur = sec;
    state = 'header';
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    const ln = i + 1;
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        closeHunk();
        state = 'after';
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeHunk();
        const sec = freshSection();
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(lines[i + 1]!);
        sec.hasPair = true;
        beginSection(sec);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) {
        closeHunk();
        const a = parseHunkHeader(line);
        if (a === null) throw new ParseFault(ln);
        curA = a;
        bodyItems = [];
        i += 1;
        continue;
      }
      const c = line[0];
      if (line === '') {
        bodyItems.push({ kind: 'ctx', text: '', empty: true });
        i += 1;
        continue;
      }
      if (c === ' ') {
        bodyItems.push({ kind: 'ctx', text: line.slice(1), empty: false });
        i += 1;
        continue;
      }
      if (c === '-') {
        bodyItems.push({ kind: 'old', text: line.slice(1), empty: false });
        i += 1;
        continue;
      }
      if (c === '+') {
        bodyItems.push({ kind: 'new', text: line.slice(1), empty: false });
        i += 1;
        continue;
      }
      if (c === '\\') {
        bodyItems.push({ kind: 'mark', text: line, empty: false });
        i += 1;
        continue;
      }
      closeHunk();
      state = 'after';
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line);
        if (a === null) throw new ParseFault(ln);
        curA = a;
        bodyItems = [];
        state = 'body';
        i += 1;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        const p = parseDiffGit(line);
        if (p === null) throw new ParseFault(ln);
        const sec = freshSection();
        sec.diffOld = p[0];
        sec.diffNew = p[1];
        beginSection(sec);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) {
        const nxt = lines[i + 1];
        if (nxt !== undefined && nxt.startsWith('+++ ')) {
          if (cur!.hasPair) {
            const sec = freshSection();
            sec.pairOld = headerPath(line);
            sec.pairNew = headerPath(nxt);
            sec.hasPair = true;
            beginSection(sec);
          } else {
            cur!.pairOld = headerPath(line);
            cur!.pairNew = headerPath(nxt);
            cur!.hasPair = true;
          }
          i += 2;
          continue;
        }
        throw new ParseFault(i + 2);
      }
      if (line.startsWith('rename from ')) {
        cur!.renameOld = line.slice(12);
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur!.renameNew = line.slice(10);
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur!.createFlag = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur!.deleteFlag = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'after') {
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line);
        if (a === null) throw new ParseFault(ln);
        curA = a;
        bodyItems = [];
        state = 'body';
        i += 1;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        const p = parseDiffGit(line);
        if (p === null) throw new ParseFault(ln);
        const sec = freshSection();
        sec.diffOld = p[0];
        sec.diffNew = p[1];
        beginSection(sec);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const sec = freshSection();
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(lines[i + 1]!);
        sec.hasPair = true;
        beginSection(sec);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // outside: no section yet
    if (line.startsWith('diff --git ')) {
      const p = parseDiffGit(line);
      if (p === null) throw new ParseFault(ln);
      const sec = freshSection();
      sec.diffOld = p[0];
      sec.diffNew = p[1];
      beginSection(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) throw new ParseFault(ln);
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = freshSection();
      sec.pairOld = headerPath(line);
      sec.pairNew = headerPath(lines[i + 1]!);
      sec.hasPair = true;
      beginSection(sec);
      i += 2;
      continue;
    }
    i += 1;
  }
  if (state === 'body') closeHunk();
  if (cur !== null) sections.push(cur);
  return sections;
}

function applyUnifiedHunk(doc: Doc, hunk: UniHunk, strict: boolean, d: number, path: string): number {
  const { oldLines, newSeg } = splitBody(hunk.items);
  if (oldLines.length === 0) {
    const oldLen = doc.lines.length;
    const pos = clamp(hunk.a + d, 0, oldLen);
    const seg = newSeg.map((piece) => piece.text);
    doc.lines.splice(pos, 0, ...seg);
    if (pos === oldLen) doc.eol = !hunk.noEol;
    return seg.length;
  }
  const hit = findAtTier(doc.lines, oldLines, strict, 0, false);
  if (hit === null) throw new EditFault('no-match', path);
  const target = hunk.a - 1 + d;
  let best = hit.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const pos of hit.occ) {
    const dist = Math.abs(pos - target);
    if (dist < bestDist) {
      best = pos;
      bestDist = dist;
    }
  }
  const seg = buildSegment(doc.lines, best, hit.tier, oldLines, newSeg);
  const oldLen = doc.lines.length;
  doc.lines.splice(best, oldLines.length, ...seg);
  if (best + oldLines.length === oldLen) doc.eol = !hunk.noEol;
  return seg.length - oldLines.length;
}

function unifiedEdits(sections: UniSection[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldP: string | null | undefined = sec.hasPair ? sec.pairOld : (sec.renameOld ?? sec.diffOld);
    const newP: string | null | undefined = sec.hasPair ? sec.pairNew : (sec.renameNew ?? sec.diffNew);
    const oldPath = oldP === undefined ? '' : oldP;
    const newPath = newP === undefined ? '' : newP;
    if (sec.createFlag || oldPath === null) {
      const target = newPath === null ? '' : newPath;
      const flat: BodyItem[] = [];
      for (const h of sec.hunks) for (const it of h.items) flat.push(it);
      const plusLines: string[] = [];
      for (const it of flat) if (it.kind === 'new') plusLines.push(it.text);
      let lastNew = -1;
      for (let k = 0; k < flat.length; k += 1) if (flat[k]!.kind === 'new') lastNew = k;
      const noEol = lastNew >= 0 && flat[lastNew + 1] !== undefined && flat[lastNew + 1]!.kind === 'mark';
      edits.push({
        apply: (tree) => {
          if (!isSafePath(target)) throw new EditFault('unsafe', target);
          if (tree.get(target) !== null) throw new EditFault('exists', target);
          tree.set(target, plusLines.length === 0 ? '' : plusLines.join('\n') + (noEol ? '' : '\n'));
        },
      });
      continue;
    }
    if (sec.deleteFlag || newPath === null) {
      const target = oldPath === null ? '' : oldPath;
      edits.push({
        apply: (tree) => {
          if (!isSafePath(target)) throw new EditFault('unsafe', target);
          if (tree.get(target) === null) throw new EditFault('missing', target);
          tree.set(target, null);
        },
      });
      continue;
    }
    const oldStr: string = oldPath as string;
    const newStr: string = newPath as string;
    if (oldStr !== newStr) {
      edits.push({
        move: { old: oldStr, fresh: newStr },
        apply: (tree) => {
          if (!isSafePath(oldStr)) throw new EditFault('unsafe', oldStr);
          if (!isSafePath(newStr)) throw new EditFault('unsafe', newStr);
          const before = tree.get(oldStr);
          if (before === null) throw new EditFault('missing', oldStr);
          if (tree.get(newStr) !== null) throw new EditFault('exists', newStr);
          const doc = parseDoc(before);
          let d = 0;
          for (const h of sec.hunks) d += applyUnifiedHunk(doc, h, strict, d, oldStr);
          tree.set(oldStr, null);
          tree.set(newStr, serializeDoc(doc));
        },
      });
      continue;
    }
    edits.push({
      apply: (tree) => {
        if (!isSafePath(oldStr)) throw new EditFault('unsafe', oldStr);
        const before = tree.get(oldStr);
        if (before === null) throw new EditFault('missing', oldStr);
        const doc = parseDoc(before);
        let d = 0;
        for (const h of sec.hunks) d += applyUnifiedHunk(doc, h, strict, d, oldStr);
        tree.set(oldStr, serializeDoc(doc));
      },
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  searchLine: number;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(s + 1);
      path = prevPath;
    }
    let sep = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new ParseFault(s + 1);
    }
    if (sep < 0) throw new ParseFault(s + 1);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') throw new ParseFault(s + 1);
    }
    if (end < 0) throw new ParseFault(s + 1);
    blocks.push({ path, searchLine: s + 1, oldLines: lines.slice(s + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevEnd = end;
    prevPath = path;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdits(blocks: SrBlock[], strict: boolean): Edit[] {
  return blocks.map((block) => ({
    apply: (tree) => {
      const p = block.path;
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (block.oldLines.length === 0) {
        if (tree.get(p) !== null) throw new EditFault('exists', p);
        tree.set(p, serializeCreated(block.newLines));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const doc = parseDoc(before);
      const hit = findAtTier(doc.lines, block.oldLines, strict, 0, false);
      if (hit === null) throw new EditFault('no-match', p);
      if (hit.occ.length > 1) throw new EditFault('ambiguous', p);
      const { newSeg } = splitBody(block.newLines.map((text) => ({ kind: 'new' as const, text })));
      const seg = buildSegment(doc.lines, hit.occ[0]!, hit.tier, block.oldLines, newSeg);
      doc.lines.splice(hit.occ[0]!, block.oldLines.length, ...seg);
      tree.set(p, serializeDoc(doc));
    },
  }));
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface ChunkItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  empty: boolean;
}

interface V4Chunk {
  anchor: string | null;
  eof: boolean;
  items: ChunkItem[];
}

interface V4Section {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4Chunk[];
}

function v4HeaderKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File:')) return 'add';
  if (line.startsWith('*** Delete File:')) return 'delete';
  if (line.startsWith('*** Update File:')) return 'update';
  return null;
}

function v4HeaderPath(line: string, kind: 'add' | 'delete' | 'update'): string {
  const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
  return line.slice(prefix.length).trim();
}

function parseV4a(lines: string[]): V4Section[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const body = lines.slice(first + 1, last);
  const sections: V4Section[] = [];
  let i = 0;
  while (i < body.length) {
    const line = body[i]!;
    const ln = first + 1 + i + 1;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const kind = v4HeaderKind(line);
    if (kind === null) throw new ParseFault(ln);
    let j = i + 1;
    while (j < body.length && v4HeaderKind(body[j]!) === null) j += 1;
    const raw = body.slice(i + 1, j);
    const rawBase = first + 1 + (i + 1) + 1;
    if (kind === 'add') {
      let end = raw.length;
      while (end > 0 && raw[end - 1] === '') end -= 1;
      const addLines: string[] = [];
      for (let k = 0; k < end; k += 1) {
        const rl = raw[k]!;
        if (rl === '') addLines.push('');
        else if (rl.startsWith('+')) addLines.push(rl.slice(1));
        else throw new ParseFault(rawBase + k);
      }
      sections.push({ kind: 'add', path: v4HeaderPath(line, kind), lineNo: ln, addLines, moveTo: null, chunks: [] });
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (!isBlank(raw[k]!)) throw new ParseFault(rawBase + k);
      }
      sections.push({ kind: 'delete', path: v4HeaderPath(line, kind), lineNo: ln, addLines: [], moveTo: null, chunks: [] });
    } else {
      let k = 0;
      while (k < raw.length && raw[k] === '') k += 1;
      let moveTo: string | null = null;
      if (k < raw.length && raw[k]!.startsWith('*** Move to:')) {
        moveTo = raw[k]!.slice('*** Move to:'.length).trim();
        k += 1;
      }
      const chunks: V4Chunk[] = [];
      let curChunk: V4Chunk | null = null;
      let seenChunk = false;
      let closedByEof = false;
      for (; k < raw.length; k += 1) {
        const rl = raw[k]!;
        const rln = rawBase + k;
        if (rl.trim() === '*** End of File') {
          if (curChunk === null) throw new ParseFault(rln);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          closedByEof = true;
          continue;
        }
        if (rl.startsWith('@@')) {
          if (curChunk !== null) chunks.push(curChunk);
          curChunk = null;
          closedByEof = false;
          const anchorText = rl.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
          seenChunk = true;
          continue;
        }
        if (rl === '' || rl.startsWith(' ') || rl.startsWith('-') || rl.startsWith('+')) {
          if (closedByEof) throw new ParseFault(rln);
          if (curChunk === null) {
            if (seenChunk) throw new ParseFault(rln);
            curChunk = { anchor: null, eof: false, items: [] };
            seenChunk = true;
          }
          if (rl === '') curChunk.items.push({ kind: 'ctx', text: '', empty: true });
          else if (rl.startsWith(' ')) curChunk.items.push({ kind: 'ctx', text: rl.slice(1), empty: false });
          else if (rl.startsWith('-')) curChunk.items.push({ kind: 'old', text: rl.slice(1), empty: false });
          else curChunk.items.push({ kind: 'new', text: rl.slice(1), empty: false });
          continue;
        }
        throw new ParseFault(rln);
      }
      if (curChunk !== null) chunks.push(curChunk);
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        if (!lc.eof) {
          while (lc.items.length > 0) {
            const it = lc.items[lc.items.length - 1]!;
            if (it.kind === 'ctx' && it.text === '') lc.items.pop();
            else break;
          }
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(ln);
      sections.push({ kind: 'update', path: v4HeaderPath(line, kind), lineNo: ln, addLines: [], moveTo, chunks });
    }
    i = j;
  }
  return sections;
}

function applyV4aChunk(doc: Doc, chunk: V4Chunk, cursor: number, strict: boolean, path: string): number {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const hit = findAtTier(doc.lines, [chunk.anchor], strict, cur, false);
    if (hit === null) throw new EditFault('no-match', path);
    cur = hit.occ[0]! + 1;
  }
  const { oldLines, newSeg } = splitBody(chunk.items);
  if (oldLines.length === 0) {
    const pos = chunk.eof ? doc.lines.length : cur;
    const seg = newSeg.map((piece) => piece.text);
    doc.lines.splice(pos, 0, ...seg);
    return pos + seg.length;
  }
  const hit = findAtTier(doc.lines, oldLines, strict, cur, chunk.eof);
  if (hit === null) throw new EditFault('no-match', path);
  const pos = hit.occ[0]!;
  const seg = buildSegment(doc.lines, pos, hit.tier, oldLines, newSeg);
  doc.lines.splice(pos, oldLines.length, ...seg);
  return pos + seg.length;
}

function v4aEdits(sections: V4Section[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.kind === 'add') {
      edits.push({
        apply: (tree) => {
          if (!isSafePath(sec.path)) throw new EditFault('unsafe', sec.path);
          if (tree.get(sec.path) !== null) throw new EditFault('exists', sec.path);
          tree.set(sec.path, serializeCreated(sec.addLines));
        },
      });
      continue;
    }
    if (sec.kind === 'delete') {
      edits.push({
        apply: (tree) => {
          if (!isSafePath(sec.path)) throw new EditFault('unsafe', sec.path);
          if (tree.get(sec.path) === null) throw new EditFault('missing', sec.path);
          tree.set(sec.path, null);
        },
      });
      continue;
    }
    const moveTo = sec.moveTo;
    if (moveTo !== null) {
      edits.push({
        move: { old: sec.path, fresh: moveTo },
        apply: (tree) => {
          if (!isSafePath(sec.path)) throw new EditFault('unsafe', sec.path);
          if (!isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
          const before = tree.get(sec.path);
          if (before === null) throw new EditFault('missing', sec.path);
          if (tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
          const doc = parseDoc(before);
          let cursor = 0;
          for (const chunk of sec.chunks) cursor = applyV4aChunk(doc, chunk, cursor, strict, sec.path);
          tree.set(sec.path, null);
          tree.set(moveTo, serializeDoc(doc));
        },
      });
      continue;
    }
    edits.push({
      apply: (tree) => {
        if (!isSafePath(sec.path)) throw new EditFault('unsafe', sec.path);
        const before = tree.get(sec.path);
        if (before === null) throw new EditFault('missing', sec.path);
        const doc = parseDoc(before);
        let cursor = 0;
        for (const chunk of sec.chunks) cursor = applyV4aChunk(doc, chunk, cursor, strict, sec.path);
        tree.set(sec.path, serializeDoc(doc));
      },
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

function jsonEditClosure(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const requireFile = (tree: Tree): string => {
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFault('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return {
      apply: (tree) => {
        if (!isSafePath(p)) throw new EditFault('unsafe', p);
        if (tree.get(p) !== null) throw new EditFault('exists', p);
        tree.set(p, text);
      },
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      apply: (tree) => {
        const before = requireFile(tree);
        const nl = before.indexOf('\n');
        const crlf = nl > 0 && before[nl - 1] === '\r';
        const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const t = lf(before);
        const old = lf(oldStr);
        let count = 0;
        for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
        if (count === 0) throw new EditFault('no-match', p);
        if (count > 1) throw new EditFault('ambiguous', p);
        const at = t.indexOf(old);
        const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
        tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return {
      apply: (tree) => {
        const before = requireFile(tree);
        const doc = parseDoc(before);
        if (lineNo < 0 || lineNo > doc.lines.length) throw new EditFault('no-match', p);
        doc.lines.splice(lineNo, 0, ...add);
        tree.set(p, serializeDoc(doc));
      },
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = jsonEditClosure(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditClosure(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(idx + 1);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Running the patch (sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(parseSearchReplace(lines), strict);
    else edits = v4aEdits(parseV4a(lines), strict);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFault[] = [];
  const moves: Array<{ old: string; fresh: string }> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit.apply(tree);
      if (edit.move !== undefined) moves.push(edit.move);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const stateOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const used = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const mv of moves) {
    if (used.has(mv.old) || used.has(mv.fresh)) continue;
    if (tree.original(mv.old) !== null && stateOf(mv.old) === null && tree.original(mv.fresh) === null && stateOf(mv.fresh) !== null) {
      rows.push({ key: mv.fresh, line: `R ${mv.old} -> ${mv.fresh}` });
      used.add(mv.old);
      used.add(mv.fresh);
    }
  }
  for (const p of changed) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
