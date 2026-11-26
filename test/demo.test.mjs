import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The quickstart's expected output is the first ```text block after "## Expected output".
const expectedOutput = () => {
  const doc = readFileSync(join(root, 'docs', 'quickstart.md'), 'utf8');
  return doc.split('## Expected output')[1].match(/```text\n([\s\S]*?)```/)[1];
};

test('node scripts/demo.mjs exits 0, ends with verify: ok and prints exactly the quickstart output', () => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'demo.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\nverify: ok\n$/);
  assert.equal(r.stdout, expectedOutput());
});

const PRIVATE = [
  ['a Windows home path', /[A-Za-z]:[\\/]+Users[\\/]/i],
  ['a Unix home path', /\/(home|Users)\/[^/\s]/],
  ['an e-mail address', /[\w.+-]+@[\w-]+(\.[\w-]+)+/],
  ['a token', /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[\w-]{10,})/],
];

const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

// Every commit author of this repo is a real name that must never leak into a fixture.
function authorNames(t) {
  const r = spawnSync('git', ['log', '--format=%an'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    t.diagnostic(`git log failed, author-name check skipped: ${r.stderr.trim()}`);
    return [];
  }
  return [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))];
}

test('no file under examples/ or fixtures/ holds a real name, e-mail, home path or token', (t) => {
  const names = authorNames(t).map((n) => [`the name ${n}`, new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]);
  const hits = [];
  for (const file of [...filesUnder(join(root, 'examples')), ...filesUnder(join(root, 'fixtures'))]) {
    const text = readFileSync(file, 'utf8');
    for (const [label, re] of [...PRIVATE, ...names]) if (re.test(text)) hits.push(`${relative(root, file)}: ${label}`);
  }
  assert.deepEqual(hits, []);
});
