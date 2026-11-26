import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSha } from '../lib/plan-hash.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'councilkit');
const PLAN = '# Plan\n\nAdd --json output.\n';
// A test command that prints a known line and exits with `code`, quoted for sh and cmd alike.
const nodeCmd = (code) => `"${process.execPath}" -e "console.log('ran'); process.exit(${code})"`;

// A temp git repo with a base commit, one change commit on top, and a recorded plan.
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(dir, '.gitignore'), '.councilkit/\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'change');
  const head = git('rev-parse', 'HEAD');
  mkdirSync(join(dir, '.councilkit', 'demo'), { recursive: true });
  const plan = join(dir, '.councilkit', 'demo', 'plan.md');
  writeFileSync(plan, PLAN);
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' });
  const ledger = join(dir, '.councilkit', 'demo', 'ledger.jsonl');
  const events = () => readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const add = (type, data = '{}') => assert.equal(cli('ledger', 'append', '--slug', 'demo', '--type', type, '--data', data).status, 0);
  add('plan.created');
  return { dir, git, base, head, plan, cli, events, add };
}

test('build record appends one build.recorded with base, head and output SHAs', (t) => {
  const { base, head, cli, events } = repo(t);
  const before = events().length;
  const r = cli('build', 'record', '--slug', 'demo', '--base', base, '--test', nodeCmd(0));
  assert.equal(r.status, 0, r.stderr);
  const all = events();
  assert.equal(all.length, before + 1);
  const e = all.at(-1);
  assert.equal(e.type, 'build.recorded');
  assert.equal(e.plan_sha, planSha(PLAN));
  assert.equal(e.data.base_sha, base);
  assert.equal(e.data.head_sha, head);
  assert.equal(e.data.diff_lines, 3);
  assert.equal(e.data.test_cmd, nodeCmd(0));
  assert.equal(e.data.exit, 0);
  assert.equal(e.data.timed_out, false);
  assert.ok(Number.isSafeInteger(e.data.duration_ms) && e.data.duration_ms >= 0);
  assert.match(e.data.output_sha256, /^sha256:[0-9a-f]{64}$/);
  const expected = `sha256:${createHash('sha256').update('ran\n').digest('hex')}`;
  // The output itself is not stored, only its hash (stdout then stderr; `ran` plus a newline here).
  assert.ok(!JSON.stringify(e).includes('"ran'));
  assert.equal(e.data.output_sha256, expected);
  assert.equal(cli('ledger', 'verify', '--slug', 'demo').status, 0);
});

test('a failing test command is recorded with its non-zero exit and the CLI exits 1', (t) => {
  const { base, cli, events } = repo(t);
  const r = cli('build', 'record', '--slug', 'demo', '--base', base, '--test', nodeCmd(3));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /test command exited 3; recorded/);
  const e = events().at(-1);
  assert.equal(e.type, 'build.recorded');
  assert.equal(e.data.exit, 3);
});

test('a test command over the timeout is killed and recorded as timed out', (t) => {
  const { base, cli, events } = repo(t);
  const slow = `"${process.execPath}" -e "setTimeout(() => {}, 20000)"`;
  const r = cli('build', 'record', '--slug', 'demo', '--base', base, '--test', slow, '--timeout', '1');
  assert.equal(r.status, 1);
  const e = events().at(-1);
  assert.equal(e.data.timed_out, true);
  assert.notEqual(e.data.exit, 0);
  // Killing only the shell would leave node holding the pipes open until its own 20 s ran out.
  assert.ok(e.data.duration_ms < 10000, `took ${e.data.duration_ms} ms: the child outlived the kill`);
});

test('build record refuses uncommitted changes (exit 2, nothing appended); the ledger itself does not count', (t) => {
  const { dir, git, base, cli, events, add } = repo(t);
  const before = events().length;
  writeFileSync(join(dir, 'a.txt'), 'edited\n');
  const edited = cli('build', 'record', '--slug', 'demo', '--base', base, '--test', nodeCmd(0));
  assert.equal(edited.status, 2);
  assert.match(edited.stderr, /uncommitted change/);
  git('checkout', '--', 'a.txt');
  writeFileSync(join(dir, 'new.txt'), 'x\n');
  assert.equal(cli('build', 'record', '--slug', 'demo', '--base', base, '--test', nodeCmd(0)).status, 2);
  assert.equal(events().length, before);
  rmSync(join(dir, 'new.txt'));
  // A ledger committed to the repo changes on every append and must not make the tree dirty.
  git('add', '-f', '.councilkit');
  git('commit', '-q', '-m', 'track ledger');
  add('gate.passed');
  const r = cli('build', 'record', '--slug', 'demo', '--base', base, '--test', nodeCmd(0));
  assert.equal(r.status, 0, r.stderr);
});

test('build record: bad usage and bad base exit 2 and write nothing', (t) => {
  const { cli, events } = repo(t);
  const before = events().length;
  assert.equal(cli('build', 'record', '--slug', 'demo', '--test', nodeCmd(0)).status, 2);
  assert.equal(cli('build', 'record', '--slug', 'demo', '--base', 'HEAD').status, 2);
  assert.equal(cli('build', 'record', '--slug', 'demo', '--base', 'HEAD', '--test', nodeCmd(0), '--timeout', '0').status, 2);
  const bad = cli('build', 'record', '--slug', 'demo', '--base', 'no-such-ref', '--test', nodeCmd(0));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no-such-ref/);
  assert.equal(cli('build', 'record', '--slug', 'demo', '--base', '--all', '--test', nodeCmd(0)).status, 2);
  assert.equal(events().length, before);
});

test('gate merge: needs a passing build for HEAD, and blocks once plan.md changes', (t) => {
  const { dir, git, base, plan, cli, events, add } = repo(t);
  // No build.recorded yet.
  const none = cli('gate', 'merge', '--slug', 'demo');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no build\.recorded for head/);
  assert.equal(events().at(-1).type, 'gate.blocked');
  assert.equal(events().at(-1).data.gate, 'merge');

  // A failing build for HEAD does not count.
  cli('build', 'record', '--slug', 'demo', '--base', base, '--test', nodeCmd(3));
  assert.match(cli('gate', 'merge', '--slug', 'demo').stderr, /exited 3/);

  // A passing build for HEAD opens the gate.
  assert.equal(cli('build', 'record', '--slug', 'demo', '--base', base, '--test', nodeCmd(0)).status, 0);
  add('gate.passed');
  const ok = cli('gate', 'merge', '--slug', 'demo');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^ok: plan sha256:[0-9a-f]{64} build seq \d+ head [0-9a-f]{40}/);

  // A new commit moves HEAD: the earlier build no longer counts.
  writeFileSync(join(dir, 'b.txt'), 'x\n');
  git('add', 'b.txt');
  git('commit', '-q', '-m', 'more');
  assert.match(cli('gate', 'merge', '--slug', 'demo').stderr, /no build\.recorded for head/);
  assert.equal(cli('build', 'record', '--slug', 'demo', '--base', base, '--test', nodeCmd(0)).status, 0);
  assert.equal(cli('gate', 'merge', '--slug', 'demo').status, 0);

  // Acceptance (3): editing plan.md after gate.passed makes gate merge exit 2.
  appendFileSync(plan, 'One more line.\n');
  const edited = cli('gate', 'merge', '--slug', 'demo');
  assert.equal(edited.status, 2);
  assert.match(edited.stderr, /plan changed since last review/);
  assert.equal(cli('ledger', 'verify', '--slug', 'demo').status, 0);
});

test('gate merge outside a git repository exits 2', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-build-nogit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.councilkit', 'demo'), { recursive: true });
  writeFileSync(join(dir, '.councilkit', 'demo', 'plan.md'), PLAN);
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) } });
  assert.equal(cli('ledger', 'append', '--slug', 'demo', '--type', 'plan.created', '--data', '{}').status, 0);
  const r = cli('gate', 'merge', '--slug', 'demo');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a git repository/);
});
