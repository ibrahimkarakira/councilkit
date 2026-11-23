import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalisePlan, planSha } from '../lib/plan-hash.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => join(root, 'fixtures', name);
const sha = (s) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;
const cli = (...args) => spawnSync(process.execPath, [join(root, 'bin', 'councilkit'), ...args], { encoding: 'utf8' });

// Pinned value for fixtures/plan-ok.md (equals `sha256sum fixtures/plan-ok.md`, since that file is
// already normalised); the roadmap's ledger example (section 3.7) quotes it as plan_sha.
const PLAN_OK_SHA = 'sha256:1e885578be710941ce0d2a31dbff5406209081435660ae0aaadfebbf8ce3cee7';

test('normalisePlan: CRLF equals LF', () => {
  assert.equal(normalisePlan('# Plan\r\n\r\nStep one.\r\n'), '# Plan\n\nStep one.\n');
  assert.equal(planSha('a\r\nb\r\n'), planSha('a\nb\n'));
});

test('normalisePlan: a leading BOM is ignored', () => {
  assert.notEqual('\uFEFF# Plan\n', '# Plan\n');
  assert.equal(planSha('\uFEFF# Plan\n'), planSha('# Plan\n'));
});

test('normalisePlan: trailing spaces and tabs on each line are ignored', () => {
  assert.equal(normalisePlan('a  \nb\t\n c \n'), 'a\nb\n c\n');
});

test('normalisePlan: exactly one trailing newline', () => {
  assert.equal(normalisePlan('a'), 'a\n');
  assert.equal(normalisePlan('a\n\n\n'), 'a\n');
  assert.equal(normalisePlan('a\r\n \r\n\t\n'), 'a\n');
});

test('normalisePlan: an empty or blank plan normalises to a single newline', () => {
  assert.equal(normalisePlan(''), '\n');
  assert.equal(normalisePlan('\uFEFF  \r\n\n'), '\n');
  assert.equal(planSha(''), sha('\n'));
});

test('planSha: is sha256: plus the hex digest of the normalised UTF-8 bytes', () => {
  assert.equal(planSha('Plan: résumé ✓\n'), sha('Plan: résumé ✓\n'));
  assert.match(planSha('x'), /^sha256:[0-9a-f]{64}$/);
});

test('planSha: a one-word edit changes the hash', () => {
  assert.notEqual(planSha('Add a --json flag.\n'), planSha('Add a --yaml flag.\n'));
});

test('planSha: leading indentation is content, not noise', () => {
  assert.notEqual(planSha('- a\n  - b\n'), planSha('- a\n- b\n'));
});

test('planSha: rejects non-string input', () => {
  assert.throws(() => planSha(Buffer.from('a')), TypeError);
});

test('fixtures: the CRLF copy really has CRLF and the LF copy has none', () => {
  assert.ok(readFileSync(fixture('plan-crlf.md'), 'utf8').includes('\r\n'));
  assert.ok(!readFileSync(fixture('plan-ok.md'), 'utf8').includes('\r'));
});

test('cli: plan hash prints the pinned hash for the fixture and the same line for its CRLF copy', () => {
  const ok = cli('plan', 'hash', fixture('plan-ok.md'));
  const crlf = cli('plan', 'hash', fixture('plan-crlf.md'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `${PLAN_OK_SHA}\n`);
  assert.equal(crlf.status, 0, crlf.stderr);
  assert.equal(crlf.stdout, ok.stdout);
});

test('cli: a missing file exits 1 with a message naming it', () => {
  const r = cli('plan', 'hash', fixture('does-not-exist.md'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does-not-exist\.md/);
  assert.equal(r.stdout, '');
});

test('cli: unknown or incomplete commands exit 1 with usage', () => {
  for (const args of [[], ['plan'], ['plan', 'hash'], ['nope']]) {
    const r = cli(...args);
    assert.equal(r.status, 1, `args: ${args.join(' ')}`);
    assert.match(r.stderr, /usage: councilkit plan hash <file>/);
  }
});
