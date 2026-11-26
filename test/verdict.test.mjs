import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'councilkit');
const pass = `"${process.execPath}" -e "process.exit(0)"`;

// A temp git repo with one commit and the slug `add-json`; `fixture` copies the fixture plan and ledger.
function repo(t, { fixture = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-verdict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(dir, '.gitignore'), '.councilkit/\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'base');
  const slugDir = join(dir, '.councilkit', 'add-json');
  mkdirSync(slugDir, { recursive: true });
  copyFileSync(join(root, 'fixtures', 'plan-ok.md'), join(slugDir, 'plan.md'));
  if (fixture) copyFileSync(join(root, 'fixtures', 'ledger-ok.jsonl'), join(slugDir, 'ledger.jsonl'));
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' });
  const add = (type, data, actor) => {
    const args = ['ledger', 'append', '--slug', 'add-json', '--type', type, '--data', JSON.stringify(data)];
    if (actor) args.push('--actor', JSON.stringify(actor));
    const r = cli(...args);
    assert.equal(r.status, 0, r.stderr);
  };
  const review = (adapter, severity, extra = {}) => add('review.submitted', {
    round: 1, verdict: 'approve', ...extra,
    findings: [{ id: 'F1', anchor: 'Acceptance', category: 'testability', severity, claim: 'x' }],
  }, { role: 'reviewer', adapter, model: null });
  const build = () => assert.equal(cli('build', 'record', '--slug', 'add-json', '--base', 'HEAD', '--test', pass).status, 0);
  const ledger = join(slugDir, 'ledger.jsonl');
  const events = () => readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { cli, add, review, build, events, ledger };
}

test('fixture ledger: the round-1 blocker has no round-1 ruling, so the verdict is changes and is recorded', (t) => {
  const { cli, build, events } = repo(t, { fixture: true });
  build();
  const r = cli('verdict', '--slug', 'add-json');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /^verdict: changes\n/);
  assert.match(r.stdout, /unresolved blocker Acceptance\|testability/);
  const last = events().at(-1);
  assert.equal(last.type, 'verdict.issued');
  assert.equal(last.data.verdict, 'changes');
  assert.equal(last.data.round, 1);
  assert.equal(cli('ledger', 'verify', '--slug', 'add-json').status, 0);
});

test('no blockers, fresh gate and a passing build for HEAD yields approve', (t) => {
  const { cli, add, review, build, events } = repo(t);
  add('plan.created', {});
  review('codex', 'minor');
  build();
  const r = cli('verdict', '--slug', 'add-json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'verdict: approve\n');
  assert.deepEqual(events().at(-1).data.reasons, []);
});

test('a contested blocker the judge dismissed no longer blocks; an upheld one does', (t) => {
  const { cli, add, review, build } = repo(t);
  add('plan.created', {});
  review('codex', 'blocker');
  review('claude-code', 'minor');
  build();
  add('judge.ruled', { round: 1, contested: ['Acceptance|testability'], ruling: 'dismiss', reason: 'covered' });
  assert.equal(cli('verdict', '--slug', 'add-json').status, 0);
  add('judge.ruled', { round: 1, contested: ['Acceptance|testability'], ruling: 'uphold', reason: 'not covered' });
  assert.equal(cli('verdict', '--slug', 'add-json').status, 2);
});

test('missing build, error review, needs-human and no reviews each yield changes', (t) => {
  const { cli, add, review, build } = repo(t);
  add('plan.created', {});
  let r = cli('verdict', '--slug', 'add-json');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /no review\.submitted since the plan of record/);
  assert.match(r.stdout, /no build\.recorded for head/);
  review('codex', 'minor', { verdict: 'error' });
  build();
  r = cli('verdict', '--slug', 'add-json');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /review by codex in round 1 is an error/);
  add('judge.ruled', { round: 1, contested: ['Acceptance|testability'], ruling: 'needs-human', reason: 'unclear' });
  r = cli('verdict', '--slug', 'add-json');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /judge needs a human/);
});

test('verdict refuses a missing slug and a broken ledger', (t) => {
  const { cli, add, ledger } = repo(t);
  assert.equal(cli('verdict').status, 2);
  add('plan.created', {});
  writeFileSync(ledger, 'not json\n', { flag: 'a' });
  const r = cli('verdict', '--slug', 'add-json');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /line 2: invalid JSON/);
});

test('malformed disputes are bad input to the verdict, as they are to the judge', (t) => {
  const { cli, add, review, build } = repo(t);
  add('plan.created', {});
  review('codex', 'minor', { disputes: 'F1' });
  build();
  const r = cli('verdict', '--slug', 'add-json');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /round 1 reviews: reviews\[0\]\.disputes must be an array/);
  assert.equal(r.stdout, '');
});
