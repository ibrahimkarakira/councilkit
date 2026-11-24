// Append-only, hash-chained evidence ledger in JSON Lines (roadmap section 3.7).
// Each line: v, seq, ts, type, plan_sha, actor, data, prev, hash.
// hash = "sha256:" + SHA-256 of canonical(line without hash); prev = previous line's hash.
import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const EVENT_TYPES = Object.freeze([
  'plan.created', 'plan.rebound', 'review.submitted', 'judge.ruled', 'gate.passed',
  'gate.blocked', 'build.recorded', 'verdict.issued', 'round.opened',
]);
export const ZERO_HASH = `sha256:${'0'.repeat(64)}`;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;

// Plain objects only: a Date, Map or class instance would hash by its own keys but serialise
// differently (toJSON), so the written line would not match its hash.
const isPlainObject = (x) => x !== null && typeof x === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const sha = (s) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

// Canonical JSON (our own rule, not RFC 8785): UTF-8, object keys sorted recursively by UTF-16
// code units, no whitespace, numbers must be safe integers. Throws TypeError on anything else.
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`canonical JSON allows safe integers only, got ${value}`);
    return String(value);
  }
  // Array.from turns holes into undefined (refused below); .map would skip them and emit `[1,,2]`.
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

export function lineHash(line) {
  const { hash, ...rest } = line;
  return sha(canonical(rest));
}

function readLedger(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

function checkLine(text, seq, prev) {
  let line;
  try {
    line = JSON.parse(text);
  } catch {
    return { reason: 'invalid JSON' };
  }
  if (!isPlainObject(line)) return { reason: 'not a JSON object' };
  if (line.v !== 1) return { reason: `unsupported v ${JSON.stringify(line.v)}` };
  if (line.seq !== seq) return { reason: `seq ${JSON.stringify(line.seq)}, expected ${seq}` };
  if (!EVENT_TYPES.includes(line.type)) return { reason: `unknown event type ${JSON.stringify(line.type)}` };
  if (line.prev !== prev) return { reason: `prev ${line.prev} does not match the previous hash ${prev}` };
  let expected;
  try {
    expected = lineHash(line);
  } catch (err) {
    return { reason: err.message };
  }
  if (line.hash !== expected) return { reason: `hash mismatch: recorded ${line.hash}, computed ${expected}` };
  return { hash: line.hash };
}

// Walks the chain; `last` is the hash to chain the next line onto.
function walk(file) {
  const lines = readLedger(file).split('\n');
  const tail = lines.pop(); // '' when the file ends with a newline (or is empty)
  let prev = ZERO_HASH;
  for (let i = 0; i < lines.length; i += 1) {
    const r = checkLine(lines[i].replace(/\r$/, ''), i + 1, prev);
    if (r.reason) return { ok: false, line: i + 1, reason: r.reason };
    prev = r.hash;
  }
  if (tail !== '') return { ok: false, line: lines.length + 1, reason: 'last line has no trailing newline (partial write?)' };
  return { ok: true, line: lines.length, reason: null, last: prev };
}

// { ok, line, reason }: on success `line` is the number of lines; on failure the first bad line (1-based).
export function verify(file) {
  const { ok, line, reason } = walk(file);
  return { ok, line, reason };
}

// Appends one event and returns the written line. `event` = { type, plan_sha, actor, data }.
// ponytail: no file lock; two concurrent writers can fork the chain (verify then fails). Add a
// lock file if parallel appends to one ledger become a real use case.
export function append(file, event, { now = new Date() } = {}) {
  const { type, plan_sha: planSha, actor, data } = event ?? {};
  if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type ${JSON.stringify(type)}`);
  if (typeof planSha !== 'string' || !SHA_RE.test(planSha)) throw new Error('plan_sha must be sha256:<64 hex>');
  if (!isPlainObject(actor)) throw new Error('actor must be an object');
  if (!isPlainObject(data)) throw new Error('data must be an object');
  const state = walk(file);
  if (!state.ok) throw new Error(`refusing to append to ${file}: line ${state.line}: ${state.reason}`);
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const line = { v: 1, seq: state.line + 1, ts, type, plan_sha: planSha, actor, data, prev: state.last };
  line.hash = lineHash(line); // throws TypeError on non-canonical data (floats etc.) before any write
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  return line;
}
