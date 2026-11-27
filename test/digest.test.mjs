import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSha } from '../lib/plan-hash.mjs';
import { parseHeads } from '../lib/digest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'councilkit');
const PLAN = '# Plan\n\nAdd --json output.\n';

// A working directory with one ledger `.councilkit/demo/` of `lines` round.opened events.
function workdir(t, lines = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-digest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.councilkit', 'demo'), { recursive: true });
  writeFileSync(join(dir, '.councilkit', 'demo', 'plan.md'), PLAN);
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' });
  for (let n = 1; n <= lines; n += 1) {
    const r = cli('ledger', 'append', '--slug', 'demo', '--type', 'round.opened', '--data', `{"round":${n}}`);
    assert.equal(r.status, 0, r.stderr);
  }
  const ledger = join(dir, '.councilkit', 'demo', 'ledger.jsonl');
  const last = () => JSON.parse(readFileSync(ledger, 'utf8').trimEnd().split('\n').at(-1));
  return { dir, cli, ledger, last };
}

test('digest prints councilkit-ledger: <slug> seq=<n> head=<hash> plan=<sha>', (t) => {
  const { cli, last } = workdir(t);
  const r = cli('digest', '--slug', 'demo');
  assert.equal(r.status, 0, r.stderr);
  const { hash } = last();
  assert.equal(r.stdout, `councilkit-ledger: demo seq=3 head=${hash} plan=${planSha(PLAN)}\n`);
});

test('digest exits 2 without a ledger and 3 on a broken chain', (t) => {
  const { dir, cli, ledger } = workdir(t);
  mkdirSync(join(dir, '.councilkit', 'empty'));
  assert.equal(cli('digest', '--slug', 'empty').status, 2);
  writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('"round":2', '"round":9'));
  assert.equal(cli('digest', '--slug', 'demo').status, 3);
});

test('verify --ci exits 0 on intact ledgers and 3 after the committed plan is edited', (t) => {
  const { dir, cli } = workdir(t);
  const ok = cli('verify', '--ci');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /ok: demo seq=3/);
  writeFileSync(join(dir, '.councilkit', 'demo', 'plan.md'), `${PLAN}One more line.\n`);
  const bad = cli('verify', '--ci', '--dir', '.councilkit');
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /demo: plan\.md is .*, the ledger's last plan_sha is/);
});

test('verify --ci exits 3 on a broken chain and 2 when the directory is missing', (t) => {
  const { cli, ledger } = workdir(t);
  writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('"round":1', '"round":7'));
  const r = cli('verify', '--ci');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /line 1: hash mismatch/);
  assert.equal(cli('verify', '--ci', '--dir', 'nowhere').status, 2);
});

test('tail truncation passes plain verify (the documented limit) but fails --expect-head', (t) => {
  const { cli, ledger, last } = workdir(t);
  const head = last().hash;
  const text = readFileSync(ledger, 'utf8').trimEnd().split('\n');
  writeFileSync(ledger, `${text.slice(0, -2).join('\n')}\n`);
  assert.equal(cli('verify', '--slug', 'demo').status, 0);
  assert.equal(cli('ledger', 'verify', '--slug', 'demo').status, 0);
  const r = cli('verify', '--slug', 'demo', '--expect-head', head);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /head .* does not match the expected head/);
});

test('verify --slug --expect-head exits 0 on the matching head; a malformed head is exit 2', (t) => {
  const { cli, last } = workdir(t);
  assert.equal(cli('verify', '--slug', 'demo', '--expect-head', last().hash).status, 0);
  assert.equal(cli('verify', '--slug', 'demo', '--expect-head', 'abc').status, 2);
});

test('verify --ci --heads checks every ledger against the digest lines in the file', (t) => {
  const { dir, cli, ledger } = workdir(t);
  const digest = cli('digest', '--slug', 'demo').stdout;
  // A PR body: prose around the pasted line, CRLF endings, the line inside backticks.
  writeFileSync(join(dir, 'heads.txt'), `Evidence:\r\n\`${digest.trimEnd()}\`\r\nthanks\r\n`);
  const ok = cli('verify', '--ci', '--heads', 'heads.txt');
  assert.equal(ok.status, 0, ok.stderr);

  const text = readFileSync(ledger, 'utf8').trimEnd().split('\n');
  writeFileSync(ledger, `${text.slice(0, -1).join('\n')}\n`);
  assert.equal(cli('verify', '--ci', '--heads', 'heads.txt').status, 3);

  writeFileSync(join(dir, 'heads.txt'), 'no digest pasted\n');
  const missing = cli('verify', '--ci', '--heads', 'heads.txt');
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /demo: no councilkit-ledger line/);
  assert.equal(cli('verify', '--ci', '--heads', 'absent.txt').status, 2);
});

test('verify --ci --heads exits 3 when a digest line names a ledger that was deleted', (t) => {
  const { dir, cli } = workdir(t);
  const gone = `councilkit-ledger: gone seq=2 head=sha256:${'1'.repeat(64)} plan=sha256:${'c'.repeat(64)}`;
  writeFileSync(join(dir, 'heads.txt'), `${cli('digest', '--slug', 'demo').stdout}${gone}\n`);
  const r = cli('verify', '--ci', '--heads', 'heads.txt');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /gone: a digest line in --heads names a ledger that does not exist/);
});

test('parseHeads reads every digest line and refuses two different heads for one slug', () => {
  const h = (c) => `sha256:${c.repeat(64)}`;
  const line = (slug, head) => `councilkit-ledger: ${slug} seq=2 head=${head} plan=${h('c')}`;
  const heads = parseHeads(`${line('a', h('1'))}\n${line('b', h('2'))}\n${line('a', h('1'))}\n`);
  assert.deepEqual([...heads], [['a', h('1')], ['b', h('2')]]);
  assert.throws(() => parseHeads(`${line('a', h('1'))}\n${line('a', h('2'))}\n`), /two different heads for a/);
});

test('verify with neither --ci nor --slug is a usage error', (t) => {
  const { cli } = workdir(t, 1);
  assert.equal(cli('verify').status, 2);
  assert.equal(cli('verify', '--ci', '--slug', 'demo').status, 2);
});
