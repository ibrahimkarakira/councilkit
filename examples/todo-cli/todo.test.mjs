import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './todo.mjs';

test('add, done and list', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'todo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.TODO_FILE = join(dir, 'todos.json');
  const lines = [];
  assert.equal(run(['add', 'water', 'the', 'plants']), 0);
  assert.equal(run(['add', 'call the plumber']), 0);
  assert.equal(run(['done', '1']), 0);
  assert.equal(run(['list'], (l) => lines.push(l)), 0);
  assert.deepEqual(lines, ['1. [x] water the plants', '2. [ ] call the plumber']);
});
