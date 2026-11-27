import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter } from '../lib/adapters/index.mjs';
import { createCodexAdapter, codexArgv, NOT_FOUND } from '../lib/adapters/codex.mjs';
import { validateFinding } from '../lib/findings.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fakeBin = join(root, 'test', 'bin');
const transcript = (name) => join(root, 'fixtures', 'codex', `synthetic-${name}.jsonl`);
const SCHEMA = { type: 'object', required: ['verdict', 'findings'] };
const REQUEST = { role: 'reviewer', prompt: 'Review this plan. Reply with JSON only.\n', schema: SCHEMA, timeout_s: 30 };

// A temp dir for the fake's log; PATH holds the fake codex (first) and node, nothing else.
function setup(t, name, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'argv.json');
  const env = { ...process.env, PATH: [fakeBin, dirname(process.execPath)].join(delimiter), FAKE_CODEX_LOG: log, FAKE_CODEX_TRANSCRIPT: transcript(name), ...extra };
  return { dir, env, ran: () => existsSync(log), seen: () => JSON.parse(readFileSync(log, 'utf8')) };
}

test('codex: parsed findings from the reply validate against the finding schema', async (t) => {
  const { dir, env, seen } = setup(t, 'review-ok');
  const answer = await createCodexAdapter({ adapter: 'codex' }, { env }).run({ ...REQUEST, cwd: dir });
  assert.equal(answer.ok, true, answer.error);
  assert.equal(answer.exit, 0);
  assert.equal(answer.json.verdict, 'changes');
  assert.equal(answer.json.findings.length, 2);
  for (const f of answer.json.findings) assert.deepEqual(validateFinding(f), []);
  assert.deepEqual(JSON.parse(answer.raw), answer.json);
  const { argv, stdin } = seen();
  assert.equal(stdin, REQUEST.prompt);
  assert.deepEqual(argv.slice(0, 2), ['exec', '--json']);
  assert.equal(argv.at(-1), '-');
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
});

test('codex: a transcript ending in turn.failed is ok:false with the event message', async (t) => {
  const { dir, env } = setup(t, 'turn-failed');
  const answer = await createCodexAdapter({ adapter: 'codex' }, { env }).run({ ...REQUEST, cwd: dir });
  assert.equal(answer.ok, false);
  assert.equal(answer.json, null);
  assert.equal(answer.exit, 1);
  assert.equal(answer.error, 'synthetic: model refused the request');
});

test('codex: a stream error event is ok:false with its message', async (t) => {
  const { dir, env } = setup(t, 'error');
  const answer = await createCodexAdapter({ adapter: 'codex' }, { env }).run({ ...REQUEST, cwd: dir });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'synthetic: stream disconnected');
});

test('codex: no codex on PATH names the fix', async (t) => {
  const { dir, env } = setup(t, 'review-ok');
  const answer = await createCodexAdapter({ adapter: 'codex' }, { env: { ...env, PATH: dir } }).run({ ...REQUEST, cwd: dir });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'codex not found on PATH; install it or switch adapter');
  assert.equal(NOT_FOUND, answer.error);
});

test('codex: a run over timeout_s is killed and reported', async (t) => {
  const { dir, env } = setup(t, 'review-ok', { FAKE_CODEX_SLEEP_MS: '20000' });
  const started = Date.now();
  const answer = await createCodexAdapter({ adapter: 'codex' }, { env }).run({ ...REQUEST, cwd: dir, timeout_s: 1 });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'codex timed out after 1 s');
  assert.ok(Date.now() - started < 15000);
});

test('codex argv: --sandbox read-only unless config says otherwise; danger-full-access is never produced', async (t) => {
  const files = { schemaFile: 's.json', lastFile: 'o.txt' };
  const argv = codexArgv({ adapter: 'codex' }, files);
  assert.deepEqual(argv, ['exec', '--json', '--output-schema', 's.json', '-o', 'o.txt', '--sandbox', 'read-only', '-']);
  assert.deepEqual(codexArgv({ adapter: 'codex', model: null, sandbox: 'read-only' }, files), argv);
  const write = codexArgv({ adapter: 'codex', sandbox: 'workspace-write', model: 'some-model' }, { ...files, schemaFile: null });
  assert.deepEqual(write, ['exec', '--json', '-o', 'o.txt', '--sandbox', 'workspace-write', '-m', 'some-model', '-']);
  for (const sandbox of ['danger-full-access', 'Danger-Full-Access', 'yolo']) {
    assert.throws(() => codexArgv({ adapter: 'codex', sandbox }, files), /sandbox must be read-only or workspace-write/);
  }
  const { dir, env, ran } = setup(t, 'review-ok');
  const answer = await createCodexAdapter({ adapter: 'codex', sandbox: 'danger-full-access' }, { env }).run({ ...REQUEST, cwd: dir });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /sandbox must be read-only or workspace-write/);
  assert.equal(ran(), false, 'codex must not be started with a refused sandbox');
});

test('getAdapter returns the codex adapter', () => {
  assert.equal(getAdapter({ adapter: 'codex' }).name, 'codex');
});
