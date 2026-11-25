import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSha } from '../lib/plan-hash.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'councilkit');
const PLAN = '# Plan\n\nAdd --json output.\n';

function workdir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.councilkit', 'demo'), { recursive: true });
  const plan = join(dir, '.councilkit', 'demo', 'plan.md');
  writeFileSync(plan, PLAN);
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' });
  const ledger = join(dir, '.councilkit', 'demo', 'ledger.jsonl');
  const events = () => readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const add = (type, data = '{}') => assert.equal(cli('ledger', 'append', '--slug', 'demo', '--type', type, '--data', data).status, 0);
  return { cli, plan, events, add };
}

test('gate review: fresh, edited, rebound, and the ledger still verifies', (t) => {
  const { cli, plan, events, add } = workdir(t);
  add('plan.created');
  add('review.submitted', '{"round":1,"verdict":"approve","findings":[]}');

  // (1) Fresh plan passes.
  const fresh = cli('gate', 'review', '--slug', 'demo');
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /^ok: plan sha256:[0-9a-f]{64}/);

  // (2) Editing the plan blocks the gate and appends exactly one gate.blocked.
  appendFileSync(plan, 'One more line.\n');
  const before = events().length;
  const blocked = cli('gate', 'review', '--slug', 'demo');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, new RegExp(`plan changed since last review: expected ${planSha(PLAN)} got sha256:`));
  const after = events();
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).type, 'gate.blocked');
  assert.equal(after.at(-1).data.expected, planSha(PLAN));

  // (3) Rebind needs a reason; with one, the gate passes and the old review is reported stale.
  assert.equal(cli('plan', 'rebind', '--slug', 'demo').status, 2);
  assert.equal(cli('plan', 'rebind', '--slug', 'demo', '--reason', 'too short').status, 2);
  assert.equal(events().length, before + 1);
  const rebind = cli('plan', 'rebind', '--slug', 'demo', '--reason', 'Added the empty-list acceptance check');
  assert.equal(rebind.status, 0, rebind.stderr);
  const rebound = events().at(-1);
  assert.equal(rebound.type, 'plan.rebound');
  assert.equal(rebound.data.previous_plan_sha, planSha(PLAN));
  assert.equal(rebound.plan_sha, planSha(readFileSync(plan, 'utf8')));
  const again = cli('gate', 'review', '--slug', 'demo');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /stale: 1 review bound to an earlier plan \(seq 2\)/);

  // (4) The chain is intact.
  assert.equal(cli('ledger', 'verify', '--slug', 'demo').status, 0);
});

test('gate review blocks on a gate.passed bound to another plan hash', (t) => {
  const { cli, add, events } = workdir(t);
  add('plan.created');
  add('gate.passed', `{"gate":"review","plan_sha":"sha256:${'a'.repeat(64)}"}`);
  const r = cli('gate', 'review', '--slug', 'demo');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gate\.passed at seq 2 is bound to sha256:a{64}/);
  assert.equal(events().at(-1).type, 'gate.blocked');
});

test('gate review blocks when the ledger has no plan.created', (t) => {
  const { cli } = workdir(t);
  const r = cli('gate', 'review', '--slug', 'demo');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no plan\.created or plan\.rebound/);
});

test('gate review exits 3 on a broken ledger and 2 on bad usage', (t) => {
  const { cli, plan } = workdir(t);
  writeFileSync(join(dirname(plan), 'ledger.jsonl'), 'garbage\n');
  assert.equal(cli('gate', 'review', '--slug', 'demo').status, 3);
  assert.equal(cli('plan', 'rebind', '--slug', 'demo', '--reason', 'a long enough reason').status, 3);
  assert.equal(cli('gate', 'review').status, 2);
  assert.equal(cli('gate', 'review', '--slug', '../x').status, 2);
  assert.equal(cli('gate', 'nope', '--slug', 'demo').status, 2);
});
