export type TextSegment = { type: 'text'; text: string } | { type: 'link'; href: string };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * Splits a sentence into plain text and http(s) links, so fix instructions that mention a faucet or a docs
 * page can be rendered with real anchors. Nothing but http and https ever becomes a link.
 */
export function splitLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  const pushText = (value: string) => {
    if (value.length > 0) segments.push({ type: 'text', text: value });
  };
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const trimmed = match[0].replace(TRAILING_PUNCTUATION, '');
    pushText(text.slice(cursor, start));
    segments.push({ type: 'link', href: trimmed });
    cursor = start + trimmed.length;
  }
  pushText(text.slice(cursor));
  return segments;
}
