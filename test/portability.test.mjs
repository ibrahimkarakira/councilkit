// A Windows user and a Linux user must compute the same plan hash (#30). These tests run in the
// Windows suite and again in the node:22 and node:24 Linux containers (`check.mjs --docker`), so the
// pinned values below are the cross-OS evidence; `check.mjs --hashes` prints them per OS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSha } from '../lib/plan-hash.mjs';
import { HASH_FIXTURES, dockerRuns } from '../scripts/check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = (args, opts = {}) =>
  spawnSync(process.execPath, [join(root, 'bin', 'councilkit'), ...args], { encoding: 'utf8', ...opts });

const PLAN_OK_SHA = 'sha256:1e885578be710941ce0d2a31dbff5406209081435660ae0aaadfebbf8ce3cee7';
// Invented non-ASCII words, a tab-indented line; equals `sha256sum fixtures/plan-unicode.md`.
const PLAN_UNICODE_SHA = 'sha256:637aacfd48af198b7986c6718e56b024f463389b61b8665fe5364190034daa3f';

test('fixtures: the unicode copy is LF and normalised; its twin has a BOM, CRLF and trailing blanks', () => {
  const lf = readFileSync(join(root, 'fixtures', 'plan-unicode.md'));
  const crlf = readFileSync(join(root, 'fixtures', 'plan-unicode-crlf.md'));
  assert.ok(!lf.includes('\r'));
  assert.ok(lf.toString('utf8').includes('\t'), 'keeps a tab-indented line');
  assert.match(lf.toString('utf8'), /[^\x00-\x7f]/, 'has non-ASCII text');
  assert.deepEqual([...crlf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'starts with a UTF-8 BOM');
  assert.ok(crlf.includes('\r\n'));
  assert.match(crlf.toString('utf8'), /[ \t]\r\n/, 'has trailing blanks');
});

test('planSha: the non-ASCII fixture has the pinned hash, with or without BOM, CRLF and trailing blanks', () => {
  for (const name of ['plan-unicode.md', 'plan-unicode-crlf.md']) {
    assert.equal(planSha(readFileSync(join(root, 'fixtures', name), 'utf8')), PLAN_UNICODE_SHA, name);
  }
});

test('core.autocrlf: a CRLF checkout of plan-ok.md still hashes to the pinned value', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-crlf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'plan.md');
  writeFileSync(file, readFileSync(join(root, 'fixtures', 'plan-ok.md'), 'utf8').replace(/\n/g, '\r\n'));
  const r = cli(['plan', 'hash', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${PLAN_OK_SHA}\n`);
});

test('cli: an absolute path and a forward-slash relative path give the same hash', () => {
  const abs = cli(['plan', 'hash', join(root, 'fixtures', 'plan-unicode.md')]);
  const rel = cli(['plan', 'hash', 'fixtures/plan-unicode.md'], { cwd: root });
  assert.equal(abs.status, 0, abs.stderr);
  assert.equal(abs.stdout, `${PLAN_UNICODE_SHA}\n`);
  assert.equal(rel.stdout, abs.stdout);
});

test('.gitattributes keeps markdown LF and the CRLF fixtures byte-exact', (t) => {
  // Ask git what it resolves: a later matching line wins, so line presence alone proves nothing.
  const files = ['fixtures/plan-crlf.md', 'fixtures/plan-unicode-crlf.md', 'fixtures/plan-unicode.md'];
  const r = spawnSync('git', ['check-attr', 'text', 'eol', '--', ...files], { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) return t.skip('git unavailable');
  const out = r.stdout.replace(/\r/g, '');
  assert.match(out, /^fixtures\/plan-crlf\.md: text: unset$/m);
  assert.match(out, /^fixtures\/plan-unicode-crlf\.md: text: unset$/m);
  assert.match(out, /^fixtures\/plan-unicode\.md: text: set$/m);
  assert.match(out, /^fixtures\/plan-unicode\.md: eol: lf$/m);
});

test('check --hashes prints the platform and one hash line per fixture', () => {
  assert.deepEqual(HASH_FIXTURES, ['fixtures/plan-ok.md', 'fixtures/plan-crlf.md', 'fixtures/plan-unicode.md', 'fixtures/plan-unicode-crlf.md']);
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'check.mjs'), '--hashes'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^hashes: ${process.platform} node ${process.version}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^${PLAN_UNICODE_SHA} fixtures/plan-unicode-crlf\\.md$`, 'm'));
  assert.equal(r.stdout.match(/^sha256:/gm).length, HASH_FIXTURES.length);
});

test('--docker prints the fixture hashes in every Linux image', () => {
  const runs = dockerRuns('/repo').map((args) => args.join(' '));
  for (const image of ['node:22', 'node:24']) {
    assert.ok(runs.some((r) => r.includes(` ${image} node scripts/check.mjs --hashes`)), image);
  }
});
