// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, output and exit codes, safe paths, format
// detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9)
// and the all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];
  recordMove(old: string, nw: string): void {
    this.moves.push({ old, nw });
  }
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

// ---------- Files: lines, line breaks, final break (SPEC.md section 3) ----------

interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeFileDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** A created file's text: LF breaks, a final one when asked (no lines: empty). */
function createText(lines: string[], finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (finalBreak ? '\n' : '');
}

// ---------- Matching lines at three tiers (SPEC.md section 5) ----------

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in lines at a tier, searching from `from`. */
function occAt(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(O[j]!, tier) !== normLine(lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; strict: 0 only) at which O occurs, from `from`. */
function findTier(
  O: string[],
  lines: string[],
  strict: boolean,
  from = 0,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occAt(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of O or N: `ctx` lines are written as the file's own matched line. */
interface LItem {
  text: string;
  ctx: boolean;
}

function oTexts(items: LItem[]): string[] {
  return items.map((x) => x.text);
}

/**
 * The lines N writes when it replaces O at position `pos` of `lines` at `tier`.
 * Context lines come from the file; at tier 2 every other line is re-indented:
 * P (leading spaces/tabs of O's first line) is replaced by F (those of the file's
 * first matched line) where the line starts with P.
 */
function buildN(lines: string[], pos: number, O: LItem[], N: LItem[], tier: number): string[] {
  const out: string[] = [];
  const oCtxPos: number[] = [];
  O.forEach((it, idx) => {
    if (it.ctx) oCtxPos.push(idx);
  });
  let nCtx = 0;
  const P = O.length > 0 ? leadWs(O[0]!.text) : '';
  const F = pos < lines.length ? leadWs(lines[pos]!) : '';
  for (const it of N) {
    if (it.ctx) {
      out.push(lines[pos + oCtxPos[nCtx]!]!);
      nCtx++;
      continue;
    }
    if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(P)) {
      out.push(F + it.text.slice(P.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

// ---------- Format detection (SPEC.md section 4) ----------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- JSON edits (SPEC.md section 9) ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

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
    for (const x of v) {
      const e = jsonEdit(x);
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

// ---------- Unified diffs (SPEC.md section 6) ----------

type BLine = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };

interface Hunk {
  a: number;
  body: BLine[];
}

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** O (context + old) and N (context + new) of a hunk or chunk body. */
function splitBody(body: BLine[]): { O: LItem[]; N: LItem[] } {
  const O: LItem[] = [];
  const N: LItem[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push({ text: b.text, ctx: true });
      N.push({ text: b.text, ctx: true });
    } else if (b.kind === 'old') O.push({ text: b.text, ctx: false });
    else if (b.kind === 'new') N.push({ text: b.text, ctx: false });
  }
  return { O, N };
}

/** True when a `\` line follows the body's last context or `+` line. */
function bsAfterLastCtxOrNew(body: BLine[]): boolean {
  let last = -1;
  body.forEach((b, i) => {
    if (b.kind === 'ctx' || b.kind === 'new') last = i;
  });
  if (last < 0) return false;
  return body[last + 1]?.kind === 'bs';
}

/**
 * Apply one hunk to a working file. `d` is the sum over this section's hunks
 * applied so far of (N's length minus O's length); returns the new d.
 */
function applyHunk(doc: FileDoc, hunk: Hunk, d: number, strict: boolean, path: string): number {
  const { O, N } = splitBody(hunk.body);
  const oArr = oTexts(O);
  if (oArr.length === 0) {
    const oldLen = doc.lines.length;
    const pos = Math.max(0, Math.min(hunk.a + d, oldLen));
    const ins = N.map((x) => x.text);
    doc.lines.splice(pos, 0, ...ins);
    if (ins.length > 0 && pos === oldLen) doc.final = !bsAfterLastCtxOrNew(hunk.body);
    return d + N.length;
  }
  const found = findTier(oArr, doc.lines, strict);
  if (!found) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const runsToEnd = best + oArr.length === doc.lines.length;
  const nOut = buildN(doc.lines, best, O, N, found.tier);
  doc.lines.splice(best, oArr.length, ...nOut);
  if (runsToEnd) doc.final = doc.lines.length === 0 ? false : !bsAfterLastCtxOrNew(hunk.body);
  return d + (N.length - O.length);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  interface RawSection {
    diffOld: string | null;
    diffNew: string | null;
    pairOld: string | null;
    pairNew: string | null;
    renameOld: string | null;
    renameNew: string | null;
    newFile: boolean;
    delFile: boolean;
    hasPair: boolean;
    hunks: Hunk[];
  }
  const newSection = (): RawSection => ({
    diffOld: null,
    diffNew: null,
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    newFile: false,
    delFile: false,
    hasPair: false,
    hunks: [],
  });
  const parsePath4 = (s: string): string => {
    const t = s.slice(4);
    const tab = t.indexOf('\t');
    return (tab >= 0 ? t.slice(0, tab) : t).trim();
  };
  const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.pairOld = parsePath4(line);
        cur.pairNew = parsePath4(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      cur = newSection();
      cur.pairOld = parsePath4(line);
      cur.pairNew = parsePath4(lines[i + 1]!);
      cur.hasPair = true;
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          hunk.body.push({ kind: 'ctx', text: '' });
          j++;
        } else if (bl.startsWith(' ')) {
          hunk.body.push({ kind: 'ctx', text: bl.slice(1) });
          j++;
        } else if (bl.startsWith('-')) {
          hunk.body.push({ kind: 'old', text: bl.slice(1) });
          j++;
        } else if (bl.startsWith('+')) {
          hunk.body.push({ kind: 'new', text: bl.slice(1) });
          j++;
        } else if (bl.startsWith('\\')) {
          hunk.body.push({ kind: 'bs', text: bl });
          j++;
        } else break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i++;
      continue;
    }
    i++;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    let oldP: string | null;
    let newP: string | null;
    if (s.hasPair) {
      oldP = s.pairOld === '/dev/null' ? null : stripAB(s.pairOld!);
      newP = s.pairNew === '/dev/null' ? null : stripAB(s.pairNew!);
    } else if (s.renameOld !== null || s.renameNew !== null) {
      oldP = s.renameOld ?? s.diffOld;
      newP = s.renameNew ?? s.diffNew;
    } else {
      oldP = s.diffOld;
      newP = s.diffNew;
    }
    const creation = s.newFile || oldP === null;
    const deletion = !creation && (s.delFile || newP === null);
    if (creation) {
      const p = newP ?? '';
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let finalBreak = true;
        for (const h of hunks) {
          let last = -1;
          h.body.forEach((b, idx) => {
            if (b.kind === 'new') {
              plus.push(b.text);
              last = idx;
            }
          });
          if (last >= 0) finalBreak = h.body[last + 1]?.kind !== 'bs';
        }
        tree.now.set(p, createText(plus, finalBreak));
      });
    } else if (deletion) {
      const p = oldP ?? '';
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else if (oldP !== null && newP !== null && oldP !== newP) {
      const op = oldP;
      const np = newP;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const text = tree.get(op);
        if (text === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const doc = parseFile(text);
        let d = 0;
        for (const h of hunks) d = applyHunk(doc, h, d, strict, op);
        tree.now.set(np, writeFileDoc(doc));
        tree.now.set(op, null);
        tree.recordMove(op, np);
      });
    } else {
      const p = oldP ?? '';
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const text = tree.get(p);
        if (text === null) throw new Fail('missing', p);
        const doc = parseFile(text);
        let d = 0;
        for (const h of hunks) d = applyHunk(doc, h, d, strict, p);
        tree.now.set(p, writeFileDoc(doc));
      });
    }
  }
  return edits;
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let m = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        m = k;
        break;
      }
    }
    if (m < 0) throw new Exit2(`error: parse ${s + 1}`);
    let e = -1;
    for (let k = m + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        e = k;
        break;
      }
    }
    if (e < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, m), newLines: lines.slice(m + 1, e) });
    prevEnd = e;
    prevPath = path;
    i = e + 1;
  }
  return blocks.map((b) => {
    const p = b.path;
    if (b.oldLines.length === 0) {
      const text = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      };
    }
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseFile(before);
      const found = findTier(b.oldLines, doc.lines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const O: LItem[] = b.oldLines.map((t) => ({ text: t, ctx: false }));
      const N: LItem[] = b.newLines.map((t) => ({ text: t, ctx: false }));
      const nOut = buildN(doc.lines, pos, O, N, found.tier);
      doc.lines.splice(pos, O.length, ...nOut);
      tree.now.set(p, writeFileDoc(doc));
    };
  });
}

// ---------- V4A patches (SPEC.md section 8) ----------

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  interface VChunk {
    anchor: string | null;
    eof: boolean;
    body: BLine[];
  }
  interface VSection {
    kind: 'add' | 'del' | 'upd';
    path: string;
    lineNo: number;
    addLines: string[];
    moveTo: string | null;
    chunks: VChunk[];
  }
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const blankChunk = (c: VChunk): boolean =>
    c.anchor === null && !c.eof && c.body.every((b) => b.kind === 'ctx' && b.text === '');

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: VSection = { kind, path, lineNo: i + 1, addLines: [], moveTo: null, chunks: [] };
    sections.push(sec);
    i++;
    if (kind === 'add') {
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          sec.addLines.push(l.slice(1));
          i++;
        } else if (l === '') {
          sec.addLines.push('');
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (sec.addLines.length > 0 && sec.addLines[sec.addLines.length - 1] === '') sec.addLines.pop();
    } else if (kind === 'del') {
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (blank(l)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
    } else {
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          while (cur.body.length > 0) {
            const b = cur.body[cur.body.length - 1]!;
            if (b.kind === 'ctx' && b.text === '') cur.body.pop();
            else break;
          }
          if (!blankChunk(cur)) sec.chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('*** Move to: ')) {
          if (cur !== null && blankChunk(cur)) cur = null;
          if (cur !== null || sec.moveTo !== null || sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
          sec.moveTo = l.slice(13).trim();
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: true, body: [] };
          else cur.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          if (l === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) cur.body.push({ kind: 'old', text: l.slice(1) });
          else cur.body.push({ kind: 'new', text: l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
  }

  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.kind === 'add') {
      const p = sec.path;
      const text = sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n';
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      });
    } else if (sec.kind === 'del') {
      const p = sec.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = sec.path;
      const moveTo = sec.moveTo;
      const chunks = sec.chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const doc = parseFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const found = findTier([ch.anchor], doc.lines, strict, cursor);
            if (!found) throw new Fail('no-match', p);
            cursor = found.occ[0]! + 1;
          }
          const { O, N } = splitBody(ch.body);
          const oArr = oTexts(O);
          if (oArr.length === 0) {
            const pos = ch.eof ? doc.lines.length : cursor;
            const ins = N.map((x) => x.text);
            doc.lines.splice(pos, 0, ...ins);
            cursor = pos + ins.length;
            continue;
          }
          const found = findTier(oArr, doc.lines, strict, cursor);
          if (!found) throw new Fail('no-match', p);
          let occ = found.occ;
          if (ch.eof) occ = occ.filter((q) => q + oArr.length === doc.lines.length);
          if (occ.length === 0) throw new Fail('no-match', p);
          const pos = occ[0]!;
          const nOut = buildN(doc.lines, pos, O, N, found.tier);
          doc.lines.splice(pos, oArr.length, ...nOut);
          cursor = pos + nOut.length;
        }
        const text = writeFileDoc(doc);
        if (moveTo !== null) {
          tree.now.set(moveTo, text);
          tree.now.set(p, null);
          tree.recordMove(p, moveTo);
        } else {
          tree.now.set(p, text);
        }
      });
    }
  }
  return edits;
}

// ---------- Invocation, output and exit codes (SPEC.md sections 1, 2, 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
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
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const consumed = new Set<string>();
  const rows: Row[] = [];
  for (const m of tree.moves) {
    const o = changed.get(m.old);
    const n = changed.get(m.nw);
    if (
      o !== undefined &&
      n !== undefined &&
      o.was !== null &&
      o.now === null &&
      n.was === null &&
      n.now !== null &&
      !consumed.has(m.old) &&
      !consumed.has(m.nw)
    ) {
      consumed.add(m.old);
      consumed.add(m.nw);
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
    }
  }
  for (const [p, c] of changed) {
    if (consumed.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...changed.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = changed.get(p)!.now;
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
