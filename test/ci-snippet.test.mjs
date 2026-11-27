// Runs the `run:` lines of the docs/ci.md workflow snippet locally against the demo's ledger. No
// workflow runs in this repository; this is how the snippet stays true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demo } from '../scripts/demo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function runLines(markdown) {
  const yaml = markdown.match(/```yaml\n([\s\S]*?)```/)[1];
  return [...yaml.matchAll(/^\s*run: (.+)$/gm)].map((m) => m[1]);
}

test('the docs/ci.md snippet passes on the demo ledger and exits 3 once the plan is edited', async (t) => {
  const commands = runLines(readFileSync(join(root, 'docs', 'ci.md'), 'utf8'));
  assert.equal(commands.length, 2);
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-ci-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await demo(dir, () => {});
  // What the second actions/checkout step puts at ./councilkit.
  for (const part of ['bin', 'lib']) cpSync(join(root, part), join(dir, 'councilkit', part), { recursive: true });

  const digest = spawnSync(process.execPath, [join(root, 'bin', 'councilkit'), 'digest', '--slug', 'add-json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(digest.status, 0, digest.stderr);
  const env = { ...process.env, PR_BODY: `Ledger head:\n${digest.stdout}` };
  const run = () => commands.map((c) => spawnSync(c, { cwd: dir, env, shell: true, encoding: 'utf8' }));

  for (const r of run()) assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  appendFileSync(join(dir, '.councilkit', 'add-json', 'plan.md'), '\nA change after the last review.\n');
  const [save, verify] = run();
  assert.equal(save.status, 0, save.stderr);
  assert.equal(verify.status, 3, `${verify.stdout}${verify.stderr}`);
  assert.match(verify.stderr, /add-json: plan\.md is/);
});
