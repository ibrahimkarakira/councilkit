import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMjs, lint } from '../scripts/check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function tempTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-check-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

test('listMjs finds .mjs files recursively and skips node_modules and .git', (t) => {
  const dir = tempTree({
    'a.mjs': '',
    'sub/b.mjs': '',
    'c.js': '',
    'node_modules/x/d.mjs': '',
    '.git/e.mjs': '',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const found = listMjs(dir).map((f) => f.slice(dir.length + 1).replaceAll('\\', '/')).sort();
  assert.deepEqual(found, ['a.mjs', 'sub/b.mjs']);
});

test('lint passes on valid files and names the file with a syntax error', (t) => {
  const dir = tempTree({ 'ok.mjs': 'export const x = 1;\n', 'bad.mjs': 'export const = ;\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const errors = [];
  assert.deepEqual(lint([join(dir, 'ok.mjs')], (e) => errors.push(e)), []);
  const failed = lint(listMjs(dir), (e) => errors.push(e));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /bad\.mjs$/);
  assert.match(errors.join(''), /SyntaxError/);
});

test('plugin manifest is named councilkit and no marketplace file is shipped', () => {
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'councilkit');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(existsSync(join(root, '.claude-plugin', 'marketplace.json')), false);
});

test('--docker runs the full suite per image, then the e2e test with --network none', async () => {
  const { dockerRuns } = await import('../scripts/check.mjs');
  const runs = dockerRuns('/repo');
  const offline = runs.filter((args) => args.join(' ').includes('--network none'));
  assert.ok(offline.length >= 1);
  for (const args of offline) assert.deepEqual(args.slice(-3), ['node', '--test', 'test/e2e.test.mjs']);
  assert.ok(runs.some((args) => args.at(-1) === '--test'), 'the full suite still runs in Docker');
});
