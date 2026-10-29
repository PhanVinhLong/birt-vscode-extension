/**
 * Re-encode script content the way BIRT Designer writes it.
 *
 * BIRT escapes `&` as `&amp;` *inside* CDATA sections and decodes it again when
 * it loads the report, so `a && b` is stored as `a &amp;&amp; b`. It does not
 * escape `<`, `>` or `"` there - CDATA already makes those unambiguous, and the
 * corpus bears this out: of the characters inside `<method>` and
 * `<text-property>` CDATA, every `<` and `>` is raw while almost every `&` is
 * escaped. Editing a report by hand in a plain editor breaks that convention
 * and shows up as noise the next time the file is opened in the designer.
 *
 * Plain XML text (`<expression>` and friends) is deliberately left alone: raw
 * `&` or `<` there would make the file malformed, so it is already correct in
 * any file an XML parser accepts.
 */

export interface EncodeEdit {
  /** Document offsets of the character to replace. */
  start: number;
  end: number;
  replacement: string;
}

/** A complete entity reference, matched only where `lastIndex` points. */
const ENTITY_AT = /&(?:#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/y;

/** The elements BIRT stores as CDATA. */
const CDATA_REGION = /<(?:method|text-property)\b[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>/g;

const CDATA_CLOSE_LENGTH = ']]>'.length;

/**
 * Every `&` inside a CDATA script block that is not already the start of an
 * entity reference. Leaving existing references alone is what makes this
 * idempotent: `&amp;` decodes to `&` and encodes back to `&amp;`.
 */
export function findEncodeEdits(text: string): EncodeEdit[] {
  const edits: EncodeEdit[] = [];

  CDATA_REGION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CDATA_REGION.exec(text)) !== null) {
    const content = match[1];
    const base = match.index + match[0].length - CDATA_CLOSE_LENGTH - content.length;

    let i = content.indexOf('&');
    while (i !== -1) {
      ENTITY_AT.lastIndex = i;
      if (!ENTITY_AT.test(content)) {
        edits.push({ start: base + i, end: base + i + 1, replacement: '&amp;' });
      }
      i = content.indexOf('&', i + 1);
    }
  }

  return edits;
}

/** Apply edits produced by `findEncodeEdits`, which are already in order. */
export function applyEdits(text: string, edits: readonly EncodeEdit[]): string {
  if (edits.length === 0) return text;

  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(text.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/** Convenience wrapper for callers that just want the corrected text. */
export function encodeDocument(text: string): string {
  return applyEdits(text, findEncodeEdits(text));
}
