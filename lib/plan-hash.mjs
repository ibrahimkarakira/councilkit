// Plan normalisation and hashing (roadmap section 3.7). A review binds to `planSha(plan)`, so the
// hash ignores line-ending, BOM and trailing-space noise but changes on any content edit.
import { createHash } from 'node:crypto';

// Strip a leading BOM, CRLF to LF, trim trailing spaces and tabs on each line, end with exactly
// one newline. An empty or blank plan normalises to "\n". Leading indentation is kept: it is content.
export function normalisePlan(text) {
  if (typeof text !== 'string') throw new TypeError('normalisePlan expects a string');
  const body = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '');
  return `${body}\n`;
}

// "sha256:" + SHA-256 hex digest of the UTF-8 bytes of the normalised plan.
export function planSha(text) {
  return `sha256:${createHash('sha256').update(normalisePlan(text), 'utf8').digest('hex')}`;
}
