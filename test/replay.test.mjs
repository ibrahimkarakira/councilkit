import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter } from '../lib/adapters/index.mjs';
import { requestKey } from '../lib/adapters/replay.mjs';
import { canonical } from '../lib/ledger.mjs';
import { record } from '../scripts/record-transcript.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const transcripts = join(root, 'fixtures', 'transcripts');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function tempRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fakeAdapter = (response) => ({ calls: 0, async run() { this.calls += 1; return response; } });
const REQUEST = { role: 'reviewer', prompt: 'Review the plan.', schema: { type: 'object' } };
const RESPONSE = { ok: true, json: { verdict: 'approve', findings: [] }, raw: '{"verdict":"approve","findings":[]}', exit: 0 };

test('requestKey: sha256 of canonical {role, prompt, schema}; cwd and timeout_s are not part of the key', () => {
  const hex = createHash('sha256').update(canonical(REQUEST), 'utf8').digest('hex');
  assert.equal(requestKey(REQUEST), hex);
  assert.equal(requestKey({ ...REQUEST, cwd: '/some/where', timeout_s: 5 }), hex);
  assert.notEqual(requestKey({ ...REQUEST, prompt: 'Other.' }), hex);
});

test('replay answers each recorded toy-plan request with identical JSON', async () => {
  const files = readdirSync(transcripts).filter((f) => f.endsWith('.json')).sort();
  assert.equal(files.length, 2);
  const adapter = getAdapter({ adapter: 'replay' });
  for (const file of files) {
    const fixture = readJson(join(transcripts, file));
    assert.equal(file, `${requestKey(fixture.request)}.json`);
    const answer = await adapter.run({ ...fixture.request, cwd: root, timeout_s: 600 });
    assert.deepEqual(answer, fixture.response);
    assert.equal(answer.ok, true);
  }
});

test('replay with no fixture returns ok:false naming the key', async (t) => {
  const dir = tempRepo(t);
  const answer = await getAdapter({ adapter: 'replay' }).run({ ...REQUEST, cwd: dir });
  assert.equal(answer.ok, false);
  assert.equal(answer.json, null);
  assert.equal(answer.error, `no transcript for sha256:${requestKey(REQUEST)}`);
});

test('replay refuses a fixture whose request does not match its file name', async (t) => {
  const dir = tempRepo(t);
  const key = requestKey(REQUEST);
  mkdirSync(join(dir, 'fixtures', 'transcripts'), { recursive: true });
  const fixture = { request: { ...REQUEST, prompt: 'tampered' }, response: RESPONSE };
  writeFileSync(join(dir, 'fixtures', 'transcripts', `${key}.json`), JSON.stringify(fixture));
  const answer = await getAdapter({ adapter: 'replay' }).run({ ...REQUEST, cwd: dir });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /does not match its request/);
});

test('getAdapter names adapters that do not exist yet', () => {
  assert.throws(() => getAdapter({ adapter: 'codex' }), /adapter "codex" is not available yet/);
  assert.throws(() => getAdapter({ adapter: 'nope' }), /unknown adapter "nope"/);
});

test('record writes a fixture that replay answers identically', async (t) => {
  const dir = tempRepo(t);
  const out = join(dir, 'fixtures', 'transcripts');
  const inner = fakeAdapter(RESPONSE);
  const file = await record(inner, { ...REQUEST, cwd: dir }, out);
  assert.equal(inner.calls, 1);
  assert.equal(file, join(out, `${requestKey(REQUEST)}.json`));
  assert.deepEqual(readJson(file), { request: REQUEST, response: RESPONSE });
  assert.deepEqual(await getAdapter({ adapter: 'replay' }).run({ ...REQUEST, cwd: dir }), RESPONSE);
});

for (const [label, text] of [
  ['a Windows home path', 'see C:\\Users\\someone\\repo\\plan.md'],
  ['a Linux home path', 'see /home/someone/repo/plan.md'],
  ['a macOS home path', 'see /Users/someone/repo/plan.md'],
  ['an e-mail address', 'ask someone@example.com'],
]) {
  test(`record refuses a fixture containing ${label}`, async (t) => {
    const dir = tempRepo(t);
    const out = join(dir, 'transcripts');
    const response = { ...RESPONSE, raw: text };
    await assert.rejects(record(fakeAdapter(response), REQUEST, out), /refusing to write transcript/);
    await assert.rejects(record(fakeAdapter(RESPONSE), { ...REQUEST, prompt: text }, out), /refusing to write transcript/);
    assert.equal(existsSync(out), false);
  });
}
