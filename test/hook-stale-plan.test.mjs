import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSha } from '../lib/plan-hash.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'councilkit');
const hook = join(root, 'scripts', 'hook-stale-plan.mjs');
// A PreToolUse payload recorded from a live Claude Code 2.1.331 session (ids and paths replaced).
const RECORDED = JSON.parse(readFileSync(join(root, 'fixtures', 'hooks', 'pretooluse-agent.json'), 'utf8'));
const PLAN = '# Plan\n\nAdd --json output.\n';

function project(t, { councilkit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-hook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = join(dir, '.councilkit', 'demo', 'plan.md');
  if (councilkit) {
    mkdirSync(dirname(plan), { recursive: true });
    writeFileSync(plan, PLAN);
    const r = spawnSync(process.execPath, [bin, 'ledger', 'append', '--slug', 'demo', '--type', 'plan.created', '--data', '{}'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  return { dir, plan };
}

function payload(cwd, { tool = 'Agent', agent = 'councilkit:lens-correctness' } = {}) {
  return { ...RECORDED, cwd, tool_name: tool, tool_input: { ...RECORDED.tool_input, subagent_type: agent } };
}

function runHook(input) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: 'utf8', env });
}

test('hook: a lens agent on a fresh plan is allowed silently', (t) => {
  const { dir } = project(t);
  const r = runHook(payload(dir));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('hook: a lens agent on a stale plan is denied with both hashes', (t) => {
  const { dir, plan } = project(t);
  appendFileSync(plan, 'One more line.\n');
  const r = runHook(payload(dir));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, new RegExp(`expected ${planSha(PLAN)} got ${planSha(readFileSync(plan, 'utf8'))}`));
  assert.match(out.permissionDecisionReason, /demo/);
});

test('hook: a denied launch writes nothing to the ledger', (t) => {
  const { dir, plan } = project(t);
  appendFileSync(plan, 'One more line.\n');
  const ledger = join(dirname(plan), 'ledger.jsonl');
  const before = readFileSync(ledger, 'utf8');
  for (let i = 0; i < 3; i++) assert.equal(JSON.parse(runHook(payload(dir)).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(readFileSync(ledger, 'utf8'), before);
});

test('hook: unrelated tools and non-lens agents are allowed silently, even on a stale plan', (t) => {
  const { dir, plan } = project(t);
  appendFileSync(plan, 'One more line.\n');
  for (const input of [payload(dir, { tool: 'Bash' }), payload(dir, { agent: 'general-purpose' }), payload(dir, { agent: 'councilkit:judge' })]) {
    const r = runHook(input);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  }
});

test('hook: without .councilkit/ a lens launch is allowed', (t) => {
  const { dir } = project(t, { councilkit: false });
  const r = runHook(payload(dir));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('hook: a broken ledger denies a lens launch; unreadable stdin is a non-blocking error', (t) => {
  const { dir, plan } = project(t);
  writeFileSync(join(dirname(plan), 'ledger.jsonl'), 'garbage\n');
  const denied = runHook(payload(dir));
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const bad = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
});

test('hooks.json registers the script on the Agent tool in exec form', () => {
  const config = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const [entry] = config.hooks.PreToolUse;
  assert.equal(entry.matcher, 'Agent');
  assert.deepEqual(entry.hooks, [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/hook-stale-plan.mjs'] }]);
});
