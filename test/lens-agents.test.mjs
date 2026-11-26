// Lint for the panel's lens agents: one per default lens, each forbidding write tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../lib/config.mjs';

const agents = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents');
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];
const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function frontmatter(file) {
  const m = readFileSync(join(agents, file), 'utf8').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${file}: no frontmatter`);
  return Object.fromEntries(m[1].split('\n').map((l) => l.match(/^([A-Za-z]+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2]]));
}

const lensFiles = readdirSync(agents).filter((f) => f.startsWith('lens-') && f.endsWith('.md')).sort();

test('one lens agent per lens named in the default panel tiers', () => {
  const lenses = [...new Set(DEFAULTS.panel.tiers.flatMap((t) => t.lenses))].sort();
  assert.deepEqual(lensFiles, lenses.map((l) => `lens-${l}.md`));
});

for (const file of lensFiles) {
  test(`${file} forbids write tools and returns findings JSON`, () => {
    const fm = frontmatter(file);
    assert.equal(fm.name, file.replace(/\.md$/, ''));
    assert.ok(fm.description, 'description is required');
    assert.equal(fm.model, 'inherit');
    for (const tool of ['Write', 'Edit']) assert.ok(list(fm.disallowedTools).includes(tool), `disallowedTools lacks ${tool}`);
    for (const tool of WRITE_TOOLS) assert.ok(!list(fm.tools).includes(tool), `tools grants ${tool}`);
    assert.match(readFileSync(join(agents, file), 'utf8'), /finding\.schema\.json/);
  });
}
