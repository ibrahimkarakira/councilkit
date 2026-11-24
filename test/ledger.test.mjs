import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, append, verify, EVENT_TYPES, ZERO_HASH } from '../lib/ledger.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(root, 'fixtures', 'ledger-ok.jsonl');
const PLAN_SHA = 'sha256:1e885578be710941ce0d2a31dbff5406209081435660ae0aaadfebbf8ce3cee7';

function tempFile(t, name = 'ledger.jsonl') {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

function writeLines(t, lines) {
  const file = tempFile(t);
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

const fixtureLines = () => readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);

// The five events of the roadmap example (section 3.7); `append` computes v, seq, prev and hash.
const EXAMPLE = [
  ['2026-01-01T10:00:00Z', 'plan.created', { role: 'author', adapter: 'claude-code', model: null },
    { path: '.councilkit/add-json/plan.md' }],
  ['2026-01-01T10:01:00Z', 'review.submitted', { role: 'reviewer', adapter: 'codex', model: null },
    { round: 1, verdict: 'changes', findings: [{ id: 'F1', anchor: 'Acceptance', category: 'testability', severity: 'blocker', claim: 'No check for empty list output.' }] }],
  ['2026-01-01T10:02:00Z', 'review.submitted', { role: 'reviewer', adapter: 'claude-code', model: null },
    { round: 1, verdict: 'approve', findings: [{ id: 'F1', anchor: 'Acceptance', category: 'testability', severity: 'minor', claim: 'Empty list case is implied.' }] }],
  ['2026-01-01T10:03:00Z', 'judge.ruled', { role: 'judge', adapter: 'codex', model: null },
    { contested: ['Acceptance|testability'], ruling: 'uphold', reason: 'Empty output is observable and untested.' }],
  ['2026-01-01T10:04:00Z', 'gate.passed', { role: 'gate', adapter: 'councilkit', model: null },
    { gate: 'review', plan_sha: PLAN_SHA }],
];

test('canonical: keys sorted recursively, no whitespace, arrays keep order', () => {
  assert.equal(canonical({ b: 1, a: { d: [3, 1], c: null } }), '{"a":{"c":null,"d":[3,1]},"b":1}');
  assert.equal(canonical('é"\n'), '"é\\"\\n"');
  assert.equal(canonical([true, false]), '[true,false]');
});

test('canonical: integers only; floats, NaN, undefined, sparse arrays and functions are refused', () => {
  // eslint-disable-next-line no-sparse-arrays
  for (const bad of [1.5, NaN, Infinity, 2 ** 60, undefined, () => 1, { a: undefined }, [1n], [1, , 2]]) {
    assert.throws(() => canonical(bad), TypeError, String(bad));
  }
});

test('append: builds the chain (v, seq, prev, hash) and verify accepts it', (t) => {
  const file = tempFile(t);
  const first = append(file, { type: 'plan.created', plan_sha: PLAN_SHA, actor: { role: 'author' }, data: {} });
  const second = append(file, { type: 'gate.passed', plan_sha: PLAN_SHA, actor: { role: 'gate' }, data: {} });
  assert.equal(first.v, 1);
  assert.equal(first.seq, 1);
  assert.equal(first.prev, ZERO_HASH);
  assert.match(first.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const { hash, ...rest } = first;
  assert.equal(hash, `sha256:${createHash('sha256').update(canonical(rest), 'utf8').digest('hex')}`);
  assert.equal(second.seq, 2);
  assert.equal(second.prev, first.hash);
  assert.deepEqual(verify(file), { ok: true, line: 2, reason: null });
});

test('append: refuses unknown type, bad plan_sha, missing actor/data and a broken ledger', (t) => {
  const file = tempFile(t);
  const ok = { type: 'plan.created', plan_sha: PLAN_SHA, actor: { role: 'author' }, data: {} };
  assert.throws(() => append(file, { ...ok, type: 'plan.deleted' }), /unknown event type/);
  assert.throws(() => append(file, { ...ok, plan_sha: 'abc' }), /plan_sha/);
  assert.throws(() => append(file, { ...ok, actor: undefined }), /actor/);
  assert.throws(() => append(file, { ...ok, data: [] }), /data/);
  assert.throws(() => append(file, { ...ok, data: { x: 0.5 } }), TypeError);
  writeFileSync(file, 'not json\n');
  assert.throws(() => append(file, ok), /refusing to append.*line 1/);
});

test('append: a Date, Map or class instance in data throws and leaves the ledger untouched', (t) => {
  const file = tempFile(t);
  const ok = { type: 'plan.created', plan_sha: PLAN_SHA, actor: { role: 'author' }, data: {} };
  append(file, ok);
  const before = readFileSync(file, 'utf8');
  for (const bad of [new Date(0), new Map([['a', 1]]), new (class Thing { constructor() { this.a = 1; } })()]) {
    assert.throws(() => canonical(bad), TypeError, String(bad));
    assert.throws(() => append(file, { ...ok, data: { when: bad } }), TypeError);
    assert.throws(() => append(file, { ...ok, data: bad }), /data/);
  }
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(verify(file), { ok: true, line: 1, reason: null });
});

test('fixture: ledger-ok.jsonl is exactly what append writes for the section 3.7 events', (t) => {
  const file = tempFile(t);
  for (const [ts, type, actor, data] of EXAMPLE) {
    append(file, { type, plan_sha: PLAN_SHA, actor, data }, { now: new Date(ts) });
  }
  assert.equal(readFileSync(file, 'utf8'), readFileSync(FIXTURE, 'utf8'));
});

test('verify: the fixture is ok', () => {
  assert.deepEqual(verify(FIXTURE), { ok: true, line: 5, reason: null });
});

test('verify: an empty or missing ledger is ok with zero lines', (t) => {
  const file = tempFile(t);
  assert.deepEqual(verify(file), { ok: true, line: 0, reason: null });
  writeFileSync(file, '');
  assert.deepEqual(verify(file), { ok: true, line: 0, reason: null });
});

test('tamper: editing one character of line 3 fails naming line 3', (t) => {
  const lines = fixtureLines();
  lines[2] = lines[2].replace('implied', 'impliet');
  const r = verify(writeLines(t, lines));
  assert.equal(r.ok, false);
  assert.equal(r.line, 3);
  assert.match(r.reason, /hash mismatch/);
});

test('tamper: deleting line 2 fails', (t) => {
  const lines = fixtureLines();
  lines.splice(1, 1);
  const r = verify(writeLines(t, lines));
  assert.equal(r.ok, false);
  assert.equal(r.line, 2);
});

test('tamper: swapping lines 2 and 3 fails', (t) => {
  const lines = fixtureLines();
  [lines[1], lines[2]] = [lines[2], lines[1]];
  const r = verify(writeLines(t, lines));
  assert.equal(r.ok, false);
  assert.equal(r.line, 2);
});

test('tamper: a re-hashed edit still breaks the next line\'s prev', (t) => {
  const lines = fixtureLines();
  const obj = JSON.parse(lines[2]);
  obj.data.verdict = 'changes';
  const { hash, ...rest } = obj;
  obj.hash = `sha256:${createHash('sha256').update(canonical(rest), 'utf8').digest('hex')}`;
  assert.notEqual(obj.hash, hash);
  lines[2] = JSON.stringify(obj);
  const r = verify(writeLines(t, lines));
  assert.equal(r.ok, false);
  assert.equal(r.line, 4);
  assert.match(r.reason, /prev/);
});

test('verify: invalid JSON, a blank line, unknown type and a truncated last line are named', (t) => {
  const lines = fixtureLines();
  assert.match(verify(writeLines(t, [lines[0], '{oops'])).reason, /invalid JSON/);
  assert.equal(verify(writeLines(t, [lines[0], '', lines[1]])).line, 2);
  const unknown = JSON.parse(lines[0]);
  unknown.type = 'plan.deleted';
  assert.match(verify(writeLines(t, [JSON.stringify(unknown)])).reason, /unknown event type/);
  const truncated = tempFile(t);
  writeFileSync(truncated, `${lines[0]}\n${lines[1]}`);
  assert.deepEqual(verify(truncated), { ok: false, line: 2, reason: 'last line has no trailing newline (partial write?)' });
});

test('schema: lists the same event types as the library', () => {
  const schema = JSON.parse(readFileSync(join(root, 'schemas', 'ledger-event.schema.json'), 'utf8'));
  assert.deepEqual(schema.properties.type.enum, [...EVENT_TYPES]);
  assert.deepEqual(schema.required, ['v', 'seq', 'ts', 'type', 'plan_sha', 'actor', 'data', 'prev', 'hash']);
});
