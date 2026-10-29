/**
 * Extraction of the JavaScript that BIRT embeds in a .rptdesign file.
 *
 * Two things make this less trivial than "grab the CDATA":
 *
 *  1. BIRT Designer XML-escapes `&` and `<` *inside* CDATA sections, so a
 *     condition written as `a != null && b` is stored as `a != null &amp;&amp; b`.
 *     The script has to be entity-decoded before a JavaScript parser sees it.
 *  2. Decoding shifts offsets (`&amp;` is 5 characters, `&` is 1), so every
 *     block carries a map from decoded offset back to document offset. Without
 *     it, diagnostics land on the wrong column.
 */

export type BlockKind = 'method' | 'expression' | 'value-of';

export interface ScriptBlock {
  kind: BlockKind;
  /** The `name` attribute, e.g. `initialize`, `valueExpr`. */
  name: string;
  /** Entity-decoded JavaScript, ready to parse. */
  code: string;
  /** Document offset where `code`'s first character lives. */
  contentStart: number;
  /** Document offset just past the content. */
  contentEnd: number;
  /** Document offset of the opening `<` of the element. */
  elementStart: number;
  /** decoded offset -> document offset. Length is `code.length + 1`. */
  map: Int32Array;
  /** Expressions are a single value; methods are a function body. */
  isExpression: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const ENTITY_RE = /&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]*));/g;

interface Decoded {
  text: string;
  map: Int32Array;
}

/**
 * Decode XML entities while recording, for each decoded character, the offset
 * it came from in `src`. Unknown entities (anything outside the five XML
 * predefined ones and numeric references) are left verbatim rather than
 * silently dropped.
 */
export function decodeEntities(src: string): Decoded {
  if (src.indexOf('&') === -1) {
    const map = new Int32Array(src.length + 1);
    for (let i = 0; i <= src.length; i++) map[i] = i;
    return { text: src, map };
  }

  const chars: string[] = [];
  const offsets: number[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  ENTITY_RE.lastIndex = 0;
  while ((m = ENTITY_RE.exec(src)) !== null) {
    for (let i = last; i < m.index; i++) {
      chars.push(src[i]);
      offsets.push(i);
    }

    let replacement: string | null = null;
    if (m[1] !== undefined) {
      const code = parseInt(m[1], 16);
      replacement = Number.isFinite(code) ? String.fromCodePoint(code) : null;
    } else if (m[2] !== undefined) {
      const code = parseInt(m[2], 10);
      replacement = Number.isFinite(code) ? String.fromCodePoint(code) : null;
    } else {
      replacement = NAMED_ENTITIES[m[3]] ?? null;
    }

    if (replacement === null) {
      for (let i = m.index; i < ENTITY_RE.lastIndex; i++) {
        chars.push(src[i]);
        offsets.push(i);
      }
    } else {
      for (const ch of replacement) {
        chars.push(ch);
        offsets.push(m.index);
      }
    }
    last = ENTITY_RE.lastIndex;
  }

  for (let i = last; i < src.length; i++) {
    chars.push(src[i]);
    offsets.push(i);
  }
  offsets.push(src.length);

  return { text: chars.join(''), map: Int32Array.from(offsets) };
}

/** Shift a decoded-offset map so it points at document offsets. */
function rebase(map: Int32Array, base: number): Int32Array {
  const out = new Int32Array(map.length);
  for (let i = 0; i < map.length; i++) out[i] = map[i] + base;
  return out;
}

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/**
 * Strip an optional CDATA wrapper, returning the inner text and how far into
 * `raw` it starts. Scripts written by BIRT Designer always use CDATA, but
 * hand-edited files sometimes do not.
 */
function unwrapCdata(raw: string): { inner: string; offset: number } {
  const trimmedStart = raw.length - raw.trimStart().length;
  const rest = raw.slice(trimmedStart);
  if (!rest.startsWith(CDATA_OPEN)) return { inner: raw, offset: 0 };
  const close = rest.lastIndexOf(CDATA_CLOSE);
  if (close < CDATA_OPEN.length) return { inner: raw, offset: 0 };
  return {
    inner: rest.slice(CDATA_OPEN.length, close),
    offset: trimmedStart + CDATA_OPEN.length,
  };
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`);
  return re.exec(tag)?.[1];
}

const METHOD_RE = /<method\b([^>]*)>([\s\S]*?)<\/method\s*>/g;
const EXPRESSION_RE = /<expression\b([^>]*)>([^<]*)<\/expression\s*>/g;
const VALUE_OF_RE = /<value-of\b([^>]*)>([^<]*)<\/value-of\s*>/g;

function makeBlock(
  kind: BlockKind,
  name: string,
  rawContent: string,
  rawContentStart: number,
  elementStart: number,
  isExpression: boolean,
): ScriptBlock | undefined {
  const { inner, offset } = unwrapCdata(rawContent);
  if (inner.trim() === '') return undefined;
  const decoded = decodeEntities(inner);
  const base = rawContentStart + offset;
  return {
    kind,
    name,
    code: decoded.text,
    contentStart: base,
    contentEnd: base + inner.length,
    elementStart,
    map: rebase(decoded.map, base),
    isExpression,
  };
}

/** Find every embedded script in a .rptdesign document. */
export function findScriptBlocks(text: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];

  const sources: ReadonlyArray<readonly [RegExp, BlockKind, boolean]> = [
    [METHOD_RE, 'method', false],
    [EXPRESSION_RE, 'expression', true],
    [VALUE_OF_RE, 'value-of', true],
  ];

  for (const [re, kind, isExpression] of sources) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const tag = m[1];
      // `type="constant"` expressions hold literal text, not script.
      if (kind === 'expression' && attr(tag, 'type') === 'constant') continue;

      // The open tag is `<name` + attributes + `>`, and the attribute part is
      // matched as `[^>]*`, so the first `>` is always the tag's own.
      const contentStart = m.index + m[0].indexOf('>') + 1;

      const block = makeBlock(kind, attr(tag, 'name') ?? kind, m[2], contentStart, m.index, isExpression);
      if (block) blocks.push(block);
    }
  }

  blocks.sort((a, b) => a.elementStart - b.elementStart);
  return blocks;
}
