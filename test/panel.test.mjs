import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedLines, selectLenses } from '../lib/panel.mjs';
import { DEFAULTS } from '../lib/config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'councilkit');
const TIERS = DEFAULTS.panel.tiers;

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join('');

// A temp repo with an empty base commit; commitLines(n) commits a.txt with n lines on top of it.
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-panel-'));
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
  writeFileSync(join(dir, 'a.txt'), '');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const commitLines = (n) => {
    writeFileSync(join(dir, 'a.txt'), lines(n));
    git('commit', '-q', '-am', `${n} lines`);
    return git('rev-parse', 'HEAD');
  };
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' });
  return { dir, git, base, commitLines, cli };
}

test('10, 120 and 700 changed lines select two, three and five lenses', (t) => {
  const { dir, base, commitLines } = repo(t);
  const cases = [[10, ['correctness', 'acceptance']], [120, 3], [700, 5]];
  for (const [n, want] of cases) {
    const head = commitLines(n);
    const diff = changedLines(base, head, { cwd: dir });
    assert.equal(diff.lines, n);
    const { lenses } = selectLenses(diff.lines, TIERS);
    if (Array.isArray(want)) assert.deepEqual(lenses, want);
    else assert.equal(lenses.length, want);
  }
});

test('boundary: exactly 50 is tier 1, 51 is tier 2, 400 is tier 2, 401 is tier 3', (t) => {
  const { dir, base, commitLines } = repo(t);
  for (const [n, tier] of [[50, 1], [51, 2], [400, 2], [401, 3]]) {
    const { lines: got } = changedLines(base, commitLines(n), { cwd: dir });
    assert.equal(got, n);
    assert.equal(selectLenses(got, TIERS).tier, tier, `${n} lines`);
  }
  assert.equal(selectLenses(0, TIERS).tier, 1);
});

test('binary files count as 0 changed lines and are listed', (t) => {
  const { dir, git, base } = repo(t);
  writeFileSync(join(dir, 'a.txt'), lines(3));
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
  git('add', 'a.txt', 'blob.bin');
  git('commit', '-q', '-m', 'binary');
  assert.deepEqual(changedLines(base, 'HEAD', { cwd: dir }), { lines: 3, binary: ['blob.bin'] });
});

test('renamed files are parsed from the -z record format', (t) => {
  const { dir, git, commitLines } = repo(t);
  const before = commitLines(5);
  git('mv', 'a.txt', 'b.txt');
  git('commit', '-q', '-m', 'rename');
  assert.deepEqual(changedLines(before, 'HEAD', { cwd: dir }), { lines: 0, binary: [] });
});

test('without head the working tree is compared with base', (t) => {
  const { dir, base } = repo(t);
  writeFileSync(join(dir, 'a.txt'), lines(7));
  assert.equal(changedLines(base, undefined, { cwd: dir }).lines, 7);
});

test('without head, untracked new files count; ignored files do not', (t) => {
  const { dir, base } = repo(t);
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n'); // 1 line, itself untracked
  writeFileSync(join(dir, 'new.txt'), lines(4));
  writeFileSync(join(dir, 'ignored.txt'), lines(100));
  writeFileSync(join(dir, 'a.txt'), lines(2));
  assert.equal(changedLines(base, undefined, { cwd: dir }).lines, 7);
});

test('the count is taken from the merge base, so commits on base after the branch point do not count', (t) => {
  const { dir, git, base, commitLines } = repo(t);
  git('branch', 'feature');
  commitLines(300); // base branch moves on
  const main = git('rev-parse', 'HEAD');
  git('switch', '-q', 'feature');
  writeFileSync(join(dir, 'b.txt'), lines(10));
  git('add', 'b.txt');
  git('commit', '-q', '-m', 'feature work');
  assert.equal(changedLines(main, 'HEAD', { cwd: dir }).lines, 10);
  assert.equal(changedLines(main, undefined, { cwd: dir }).lines, 10);
  assert.equal(changedLines(base, undefined, { cwd: dir }).lines, 10);
});

test('CLI: panel --base prints the lenses, --json prints the selection', (t) => {
  const { base, commitLines, cli } = repo(t);
  commitLines(120);
  const text = cli('panel', '--base', base);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /120 changed lines, tier 2: correctness, acceptance, tests/);
  const json = cli('panel', '--base', base, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    changed_lines: 120, tier: 2, lenses: ['correctness', 'acceptance', 'tests'], binary: [],
  });
});

test('CLI: panel tiers come from councilkit.json', (t) => {
  const { dir, base, commitLines, cli } = repo(t);
  commitLines(10);
  writeFileSync(join(dir, 'councilkit.json'), JSON.stringify({
    panel: { tiers: [{ max_changed_lines: 5, lenses: ['a'] }, { max_changed_lines: null, lenses: ['b'] }] },
  }));
  const r = cli('panel', '--base', base, '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).lenses, ['b']);
});

test('CLI: outside a git repo exits 2 with "not a git repository"', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-nogit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // GIT_CEILING_DIRECTORIES stops git from finding a repo above the temp dir.
  const r = spawnSync(process.execPath, [bin, 'panel', '--base', 'main'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a git repository/);
});

test('CLI: bad usage and unknown refs exit 2', (t) => {
  const { cli } = repo(t);
  assert.equal(cli('panel').status, 2); // --base is required
  const dash = cli('panel', '--base=--output=x');
  assert.equal(dash.status, 2);
  assert.match(dash.stderr, /must not start with "-"/);
  const unknown = cli('panel', '--base', 'no-such-ref');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /git merge-base failed/);
});
