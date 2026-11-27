import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSha } from '../lib/plan-hash.mjs';
import { append } from '../lib/ledger.mjs';
import { runReview } from '../lib/review-run.mjs';
import { gateMerge } from '../lib/build.mjs';
import { latestRound } from '../lib/rounds.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'councilkit');
const PLAN = '# Plan: demo\n\n## Goal\nDemo `x`.\n\n## Acceptance\n- works\n';
const BLOCKER = { id: 'F1', anchor: 'Acceptance', category: 'testability', severity: 'blocker', claim: 'No empty-list check.' };

function workdir(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-rounds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const slugDir = join(dir, '.councilkit', 'demo');
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(join(slugDir, 'plan.md'), PLAN);
  writeFileSync(join(dir, 'councilkit.json'), JSON.stringify({ reviewers: [{ id: 'alpha', adapter: 'replay' }], ...config }));
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' });
  const events = () => readFileSync(join(slugDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(cli('ledger', 'append', '--slug', 'demo', '--type', 'plan.created', '--data', '{}').status, 0);
  return { dir, slugDir, cli, events, ledger: join(slugDir, 'ledger.jsonl') };
}

// A reviewer that always reports the same finding (blocker by default), counting its calls.
const reviewer = (findings = [BLOCKER]) => {
  const calls = [];
  return { calls, adapterFor: (r) => ({ name: 'fake', async run() { calls.push(r.id); return { ok: true, json: { findings } }; } }) };
};

const runRounds = async (w, fake, n) => {
  for (let i = 0; i < n; i += 1) assert.equal((await runReview('demo', { root: w.dir, adapterFor: fake.adapterFor })).code, 0);
};

test('round 3 with an unresolved blocker blocks the next review run with the escalation text; ledger verify exits 0', async (t) => {
  const w = workdir(t);
  const fake = reviewer();
  await runRounds(w, fake, 3);
  assert.deepEqual(w.events().filter((e) => e.type === 'round.opened').map((e) => e.data.round), [1, 2, 3]);

  const r = await runReview('demo', { root: w.dir, adapterFor: fake.adapterFor });
  assert.equal(r.code, 2);
  assert.match(r.err, /review run blocked: max_fix_rounds: round 3 of 3 left 1 unresolved blocker \(Acceptance\|testability\)/);
  assert.match(r.err, /councilkit plan rebind --slug demo --reason/);
  assert.equal(fake.calls.length, 3, 'no reviewer is called once the cap is reached');
  const last = w.events().at(-1);
  assert.equal(last.type, 'gate.blocked');
  assert.deepEqual(last.data, { gate: 'review', reason: 'max_fix_rounds', round: 3, max_fix_rounds: 3, blockers: ['Acceptance|testability'], expected: planSha(PLAN), got: planSha(PLAN) });

  const verify = w.cli('ledger', 'verify', '--slug', 'demo');
  assert.equal(verify.status, 0, verify.stderr);
});

test('the CLI review run prints the escalation text and exits 2 at the cap', async (t) => {
  const w = workdir(t, { rules: { max_fix_rounds: 1 } });
  await runRounds(w, reviewer(), 1);
  const r = w.cli('review', 'run', '--slug', 'demo', '--target', 'plan');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /max_fix_rounds: round 1 of 1/);
});

test('max_fix_rounds: 5 in councilkit.json moves the cap to round 5', async (t) => {
  const w = workdir(t, { rules: { max_fix_rounds: 5 } });
  const fake = reviewer();
  await runRounds(w, fake, 5);
  const r = await runReview('demo', { root: w.dir, adapterFor: fake.adapterFor });
  assert.equal(r.code, 2);
  assert.match(r.err, /round 5 of 5/);
  assert.equal(fake.calls.length, 5);
});

test('a final round with no unresolved blocker does not block', async (t) => {
  const w = workdir(t);
  const fake = reviewer([{ ...BLOCKER, severity: 'minor' }]);
  await runRounds(w, fake, 4);
  assert.equal(latestRound(w.events().slice(1)), 4);
});

test('a dismissed blocker in the last round is resolved', async (t) => {
  const w = workdir(t);
  const fake = reviewer();
  await runRounds(w, fake, 3);
  append(w.ledger, { type: 'judge.ruled', plan_sha: planSha(PLAN), actor: { role: 'judge', adapter: 'replay', model: null }, data: { round: 3, contested: ['Acceptance|testability'], ruling: 'dismiss', reason: 'implied' } });
  assert.equal((await runReview('demo', { root: w.dir, adapterFor: fake.adapterFor })).code, 0);
});

test('plan rebind starts the round count again', async (t) => {
  const w = workdir(t, { rules: { max_fix_rounds: 1 } });
  const fake = reviewer();
  await runRounds(w, fake, 1);
  writeFileSync(join(w.slugDir, 'plan.md'), `${PLAN}- also empty lists\n`);
  assert.equal(w.cli('plan', 'rebind', '--slug', 'demo', '--reason', 'added the empty-list check').status, 0);
  const r = await runReview('demo', { root: w.dir, adapterFor: fake.adapterFor });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^round 1\n/);
});

test('gate merge blocks with reason max_fix_rounds at the cap, before looking at git', async (t) => {
  const w = workdir(t);
  await runRounds(w, reviewer(), 3);
  const r = gateMerge('demo', { root: w.dir });
  assert.equal(r.code, 2);
  assert.match(r.err, /gate merge blocked: max_fix_rounds: round 3 of 3/);
  const last = w.events().at(-1);
  assert.equal(last.type, 'gate.blocked');
  assert.equal(last.data.gate, 'merge');
  assert.equal(last.data.reason, 'max_fix_rounds');
  assert.equal(last.data.head, null);
});

test('latestRound counts round.opened and review.submitted rounds', () => {
  assert.equal(latestRound([]), 0);
  assert.equal(latestRound([{ type: 'round.opened', data: { round: 2 } }, { type: 'review.submitted', data: { round: 1 } }]), 2);
  assert.equal(latestRound([{ type: 'review.submitted', data: { round: 'x' } }, { type: 'judge.ruled', data: { round: 9 } }]), 0);
});
