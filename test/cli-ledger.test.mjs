import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSha } from '../lib/plan-hash.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'councilkit');
const PLAN = '# Plan\n\nAdd --json output.\n';

// Each test gets its own working directory with `.councilkit/demo/plan.md`.
function workdir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.councilkit', 'demo'), { recursive: true });
  writeFileSync(join(dir, '.councilkit', 'demo', 'plan.md'), PLAN);
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' });
  return { dir, cli, ledger: join(dir, '.councilkit', 'demo', 'ledger.jsonl') };
}

test('ledger append then verify exits 0; show prints the lines', (t) => {
  const { cli, ledger } = workdir(t);
  const a = cli('ledger', 'append', '--slug', 'demo', '--type', 'plan.created', '--data', '{"path":"plan.md"}');
  assert.equal(a.status, 0, a.stderr);
  const first = JSON.parse(a.stdout);
  assert.equal(first.seq, 1);
  assert.equal(first.plan_sha, planSha(PLAN)); // default --plan is .councilkit/<slug>/plan.md
  assert.deepEqual(first.data, { path: 'plan.md' });

  const b = cli('ledger', 'append', '--slug', 'demo', '--type', 'round.opened', '--data', '{"round":1}',
    '--actor', '{"role":"author","adapter":"claude-code","model":null}');
  assert.equal(b.status, 0, b.stderr);
  assert.equal(JSON.parse(b.stdout).prev, first.hash);
  assert.equal(JSON.parse(b.stdout).actor.adapter, 'claude-code');

  const v = cli('ledger', 'verify', '--slug', 'demo');
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /ok: 2 line/);

  const s = cli('ledger', 'show', '--slug', 'demo');
  assert.equal(s.status, 0, s.stderr);
  assert.equal(s.stdout, readFileSync(ledger, 'utf8'));
});

test('--plan hashes the given file instead of the slug plan', (t) => {
  const { dir, cli } = workdir(t);
  writeFileSync(join(dir, 'other.md'), 'other plan\n');
  const r = cli('ledger', 'append', '--slug', 'demo', '--type', 'plan.created', '--data', '{}', '--plan', 'other.md');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).plan_sha, planSha('other plan\n'));
});

test('verify exits 3 and names the line after a hand edit', (t) => {
  const { cli, ledger } = workdir(t);
  for (const n of [1, 2, 3]) {
    assert.equal(cli('ledger', 'append', '--slug', 'demo', '--type', 'round.opened', '--data', `{"round":${n}}`).status, 0);
  }
  writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('"round":2', '"round":9'));
  const v = cli('ledger', 'verify', '--slug', 'demo');
  assert.equal(v.status, 3);
  assert.match(v.stderr, /line 2: hash mismatch/);
});

test('unknown --type exits 2 and lists the valid types', (t) => {
  const { cli, ledger } = workdir(t);
  const r = cli('ledger', 'append', '--slug', 'demo', '--type', 'nope', '--data', '{}');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown --type "nope"/);
  assert.match(r.stderr, /plan\.created, plan\.rebound, .*round\.opened/);
  assert.equal(existsSync(ledger), false);
});

test('bad input exits 2 and writes nothing', (t) => {
  const { cli, ledger } = workdir(t);
  const cases = [
    ['ledger'],
    ['ledger', 'nope', '--slug', 'demo'],
    ['ledger', 'verify'],
    ['ledger', 'verify', '--slug', '../escape'],
    ['ledger', 'verify', '--slug', 'demo', '--bogus'],
    ['ledger', 'append', '--slug', 'demo', '--type', 'plan.created'],
    ['ledger', 'append', '--slug', 'demo', '--type', 'plan.created', '--data', 'not json'],
    ['ledger', 'append', '--slug', 'demo', '--type', 'plan.created', '--data', '[1]'],
    ['ledger', 'append', '--slug', 'demo', '--type', 'plan.created', '--data', '{"x":1.5}'],
    ['ledger', 'append', '--slug', 'demo', '--type', 'plan.created', '--data', '{}', '--actor', '"me"'],
    ['ledger', 'append', '--slug', 'demo', '--type', 'plan.created', '--data', '{}', '--plan', 'missing.md'],
  ];
  for (const args of cases) {
    const r = cli(...args);
    assert.equal(r.status, 2, `args: ${args.join(' ')}\n${r.stderr}`);
    assert.notEqual(r.stderr, '', `args: ${args.join(' ')}`);
  }
  assert.equal(existsSync(ledger), false);
});

test('verify and show on a missing ledger', (t) => {
  const { cli } = workdir(t);
  const v = cli('ledger', 'verify', '--slug', 'demo');
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /ok: 0 lines/);
  const s = cli('ledger', 'show', '--slug', 'demo');
  assert.equal(s.status, 0);
  assert.equal(s.stdout, '');
});

test('append refuses to extend a broken ledger with exit 3', (t) => {
  const { cli, ledger } = workdir(t);
  writeFileSync(ledger, 'garbage\n');
  const r = cli('ledger', 'append', '--slug', 'demo', '--type', 'round.opened', '--data', '{}');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /line 1/);
  assert.equal(readFileSync(ledger, 'utf8'), 'garbage\n');
  // Bad input is reported as bad input (2) even when the chain is also broken.
  assert.equal(cli('ledger', 'append', '--slug', 'demo', '--type', 'nope', '--data', '{}').status, 2);
});
