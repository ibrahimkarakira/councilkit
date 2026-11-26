import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSha } from '../lib/plan-hash.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'councilkit');
const PLAN = '# Plan: demo\n\n## Goal\nDemo.\n\n## Acceptance\n- works\n';
const FINDING = { id: 'F1', anchor: 'Acceptance', category: 'testability', severity: 'blocker', claim: 'No check.' };

function workdir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-ingest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const slugDir = join(dir, '.councilkit', 'demo');
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(join(slugDir, 'plan.md'), PLAN);
  const cli = (args, input) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', input });
  const events = () => readFileSync(join(slugDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ingest = (lens, input, extra = []) => cli(['review', 'ingest', '--slug', 'demo', '--lens', lens, '--round', '1', ...extra], input);
  return { dir, slugDir, cli, events, ingest };
}

test('review ingest: valid findings from stdin append review.submitted bound to the plan_sha, and the chain verifies', (t) => {
  const w = workdir(t);
  const r = w.ingest('correctness', JSON.stringify([FINDING]));
  assert.equal(r.status, 0, r.stderr);
  const r2 = w.ingest('tests', '[]');
  assert.equal(r2.status, 0, r2.stderr);
  const [a, b] = w.events();
  assert.equal(a.type, 'review.submitted');
  assert.equal(a.plan_sha, planSha(PLAN));
  assert.deepEqual(a.actor, { role: 'reviewer', adapter: 'claude-code', model: null });
  assert.deepEqual(a.data, { reviewer: 'lens-correctness', lens: 'correctness', round: 1, verdict: 'changes', findings: [FINDING] });
  assert.equal(b.plan_sha, planSha(PLAN));
  assert.deepEqual(b.data, { reviewer: 'lens-tests', lens: 'tests', round: 1, verdict: 'approve', findings: [] });
  assert.equal(w.cli(['ledger', 'verify', '--slug', 'demo']).status, 0);
});

test('review ingest: only blocker severities make the verdict "changes"', (t) => {
  const w = workdir(t);
  assert.equal(w.ingest('acceptance', JSON.stringify([{ ...FINDING, severity: 'minor' }])).status, 0);
  assert.equal(w.events()[0].data.verdict, 'approve');
});

test('review ingest: --file reads the findings and a ```json fence around them is accepted', (t) => {
  const w = workdir(t);
  const file = join(w.dir, 'out.json');
  writeFileSync(file, `\`\`\`json\n${JSON.stringify([FINDING])}\n\`\`\`\n`);
  const r = w.ingest('security', undefined, ['--file', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.events()[0].data.findings, [FINDING]);
});

for (const [name, input, error] of [
  ['not JSON', 'Looks fine to me.', /not valid JSON/],
  ['not an array', JSON.stringify({ findings: [FINDING] }), /must be a JSON array/],
  ['a finding off the schema', JSON.stringify([{ ...FINDING, severity: 'huge' }]), /findings\[0\]\.severity must be one of/],
  ['a duplicated finding id', JSON.stringify([FINDING, { ...FINDING, anchor: 'Goal' }]), /findings\[1\]\.id F1 is duplicated/],
]) {
  test(`review ingest: ${name} is recorded as verdict "error" with no findings, exit 1`, (t) => {
    const w = workdir(t);
    const r = w.ingest('performance', input);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /recorded as verdict "error"/);
    const [e] = w.events();
    assert.equal(e.type, 'review.submitted');
    assert.equal(e.plan_sha, planSha(PLAN));
    assert.equal(e.data.verdict, 'error');
    assert.deepEqual(e.data.findings, []);
    assert.match(e.data.error, error);
    assert.equal(w.cli(['ledger', 'verify', '--slug', 'demo']).status, 0);
  });
}

test('review ingest: bad usage exits 2 and writes nothing', (t) => {
  const w = workdir(t);
  for (const args of [
    ['review', 'ingest', '--lens', 'tests', '--round', '1'],
    ['review', 'ingest', '--slug', 'demo', '--round', '1'],
    ['review', 'ingest', '--slug', 'demo', '--lens', '../x', '--round', '1'],
    ['review', 'ingest', '--slug', 'demo', '--lens', 'tests', '--round', '0'],
    ['review', 'nope', '--slug', 'demo'],
  ]) {
    const r = w.cli(args, '[]');
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
  }
  const r = w.ingest('tests', undefined, ['--file', join(w.dir, 'missing.json')]);
  assert.equal(r.status, 2);
  assert.throws(() => readFileSync(join(w.slugDir, 'ledger.jsonl')), { code: 'ENOENT' });
});

test('review ingest: a broken ledger exits 3 and appends nothing', (t) => {
  const w = workdir(t);
  appendFileSync(join(w.slugDir, 'ledger.jsonl'), 'garbage\n');
  const r = w.ingest('tests', '[]');
  assert.equal(r.status, 3);
  assert.equal(readFileSync(join(w.slugDir, 'ledger.jsonl'), 'utf8'), 'garbage\n');
});
