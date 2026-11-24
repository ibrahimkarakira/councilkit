import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig, DEFAULTS, ADAPTERS } from '../lib/config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

// The first ```json block of docs/config.md is the section 3.6 example; testing it keeps the docs honest.
const docsExample = () => JSON.parse(read('docs', 'config.md').match(/```json\n([\s\S]*?)\n```/)[1]);

function tempDir(t, config) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (config !== undefined) {
    writeFileSync(join(dir, 'councilkit.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}

const errorsOf = (cfg) => validateConfig({ ...DEFAULTS, ...cfg });

test('the docs example (roadmap section 3.6) loads without error', (t) => {
  const example = docsExample();
  const config = loadConfig(tempDir(t, example));
  assert.deepEqual(config, example);
});

test('a missing file gives the defaults, and the defaults are valid', (t) => {
  assert.deepEqual(loadConfig(tempDir(t)), DEFAULTS);
  assert.deepEqual(validateConfig(DEFAULTS), []);
});

test('a partial file is merged over the defaults per section', (t) => {
  const config = loadConfig(tempDir(t, { rules: { max_fix_rounds: 5 }, judge: { timeout_s: 30 } }));
  assert.equal(config.rules.max_fix_rounds, 5);
  assert.equal(config.rules.block_on_stale_plan, true);
  assert.equal(config.judge.timeout_s, 30);
  assert.equal(config.judge.adapter, 'codex');
  assert.deepEqual(config.panel, DEFAULTS.panel);
});

test('tiers that do not ascend fail with the exact path-style message', (t) => {
  const dir = tempDir(t, { panel: { tiers: [{ max_changed_lines: 400, lenses: ['a'] }, { max_changed_lines: 50, lenses: ['b'] }] } });
  assert.throws(() => loadConfig(dir), (err) => {
    assert.equal(err.name, 'ConfigError');
    assert.deepEqual(err.errors, ['panel.tiers[1].max_changed_lines must be greater than the previous tier']);
    assert.match(err.message, /councilkit\.json/);
    return true;
  });
});

test('an unknown adapter names the path and the allowed values', () => {
  const errors = errorsOf({ reviewers: [{ id: 'x', adapter: 'gpt-magic' }] });
  assert.deepEqual(errors, [`reviewers[0].adapter must be one of ${ADAPTERS.join(', ')}`]);
});

test('max_fix_rounds below 1 is rejected', () => {
  assert.deepEqual(errorsOf({ rules: { ...DEFAULTS.rules, max_fix_rounds: 0 } }),
    ['rules.max_fix_rounds must be an integer >= 1']);
});

test('other bad values each produce one precise error', () => {
  const cases = [
    [{ version: 2 }, 'version must be 1'],
    [{ dir: '' }, 'dir must be a non-empty string'],
    [{ extra: true }, 'extra is not a known key'],
    [{ reviewers: [] }, 'reviewers must be a non-empty array'],
    [{ reviewers: [{ id: 'a', adapter: 'command' }] }, 'reviewers[0].command must be a non-empty array of non-empty strings'],
    [{ reviewers: [{ id: 'a', adapter: 'codex' }, { id: 'a', adapter: 'codex' }] }, 'reviewers[1].id duplicates reviewers[0].id'],
    [{ reviewers: [{ id: 'a', adapter: 'codex', timeout_s: 1.5 }] }, 'reviewers[0].timeout_s must be an integer >= 1'],
    [{ reviewers: [{ id: 'a', adapter: 'codex', model: 3 }] }, 'reviewers[0].model must be a string or null'],
    [{ judge: { adapter: 'codex', temp: 1 } }, 'judge.temp is not a known key'],
    [{ panel: { tiers: [{ max_changed_lines: null, lenses: ['a'] }, { max_changed_lines: 9, lenses: ['a'] }] } },
      'panel.tiers[0].max_changed_lines may be null only on the last tier'],
    [{ panel: { tiers: [{ max_changed_lines: 9, lenses: [] }] } }, 'panel.tiers[0].lenses must be a non-empty array of non-empty strings'],
    [{ rules: { ...DEFAULTS.rules, block_on_stale_plan: 'yes' } }, 'rules.block_on_stale_plan must be a boolean'],
  ];
  for (const [cfg, message] of cases) assert.deepEqual(errorsOf(cfg), [message], JSON.stringify(cfg));
});

test('invalid JSON and a non-object root fail with the file path', (t) => {
  assert.throws(() => loadConfig(tempDir(t, '{ nope')), (err) => err.name === 'ConfigError' && /councilkit\.json/.test(err.message));
  assert.throws(() => loadConfig(tempDir(t, '[]')), /the config must be a JSON object/);
});

test('a file starting with a UTF-8 BOM loads', (t) => {
  assert.deepEqual(loadConfig(tempDir(t, '﻿{}')), DEFAULTS);
});

// No JSON Schema library here, so check the one thing that would make an editor reject a partial file:
// a `required` list on a section the loader merges over its defaults.
test('the schema describes the file on disk: partial files the loader accepts meet its required lists', (t) => {
  const schema = JSON.parse(read('schemas', 'config.schema.json'));
  const partials = [{ rules: { max_fix_rounds: 5 } }, { judge: { timeout_s: 30 } }, { panel: {} }, { judge: { command: ['x'] } }];
  for (const partial of partials) {
    loadConfig(tempDir(t, partial));
    for (const [key, value] of Object.entries(partial)) {
      const section = schema.properties[key];
      const required = [...(section.required ?? []), ...(section.$ref ? schema.$defs.adapterFields.required ?? [] : [])];
      assert.deepEqual(required.filter((k) => !(k in value)), [], JSON.stringify(partial));
    }
  }
  assert.deepEqual(schema.properties.reviewers.items.required, ['id', 'adapter']);
});

test('the JSON Schema mirrors the validator: same keys, adapters and required fields', () => {
  const schema = JSON.parse(read('schemas', 'config.schema.json'));
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(DEFAULTS).sort());
  assert.deepEqual(schema.$defs.adapter.enum, ADAPTERS);
  assert.deepEqual(Object.keys(schema.properties.rules.properties).sort(), Object.keys(DEFAULTS.rules).sort());
  assert.equal(schema.additionalProperties, false);
});
