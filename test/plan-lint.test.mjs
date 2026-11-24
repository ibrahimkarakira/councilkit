import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const template = join(root, 'skills', 'plan', 'template.md');
const cli = (...args) => spawnSync(process.execPath, [join(root, 'bin', 'councilkit'), ...args], { encoding: 'utf8' });

function tempPlan(t, text) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-lint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'plan.md');
  writeFileSync(file, text);
  return file;
}

test('plan lint passes the shipped template', () => {
  const r = cli('plan', 'lint', template);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok: /);
});

test('plan lint exits 2 and names a removed section', (t) => {
  const text = readFileSync(template, 'utf8').replace(/^## Acceptance[ \t]*$/m, '');
  const r = cli('plan', 'lint', tempPlan(t, text));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing section: ## Acceptance$/m);
  assert.doesNotMatch(r.stderr, /## Goal/);
});

test('plan lint lists every missing section; CRLF and trailing spaces are fine', (t) => {
  const ok = tempPlan(t, '# Plan\r\n\r\n## Goal  \r\n## Acceptance\r\n## Non-goals\r\n## Files\r\n## Test plan\r\n');
  assert.equal(cli('plan', 'lint', ok).status, 0);

  const r = cli('plan', 'lint', tempPlan(t, '# Plan\n\n## Goal\n### Files\n'));
  assert.equal(r.status, 2);
  for (const name of ['Acceptance', 'Non-goals', 'Files', 'Test plan']) {
    assert.match(r.stderr, new RegExp(`missing section: ## ${name}$`, 'm'));
  }
});

test('plan lint ignores headings inside fenced code blocks', (t) => {
  const text = '## Goal\n## Acceptance\n## Non-goals\n## Files\n```md\n## Test plan\n```\n';
  const r = cli('plan', 'lint', tempPlan(t, text));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing section: ## Test plan/);
});

test('plan lint: unreadable file or bad usage exits 1', () => {
  assert.equal(cli('plan', 'lint', join(root, 'no-such-plan.md')).status, 1);
  assert.equal(cli('plan', 'lint').status, 1);
  assert.equal(cli('plan', 'lint', template, 'extra').status, 1);
});

test('the plan skill frontmatter matches the issue spec', () => {
  const skill = readFileSync(join(root, 'skills', 'plan', 'SKILL.md'), 'utf8');
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  assert.match(front, /^name: plan$/m);
  assert.match(front, /^description: \S/m);
  assert.match(front, /^disable-model-invocation: true$/m);
  assert.match(front, /^argument-hint: "\[slug\] \[one-line task\]"$/m);
  assert.match(skill, /councilkit plan lint/);
  assert.match(skill, /councilkit ledger append .*--type plan\.created/);
});
