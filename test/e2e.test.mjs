// End-to-end: the whole pipeline (plan, plan review, judge, build, panel, verdict, report) on the
// examples/todo-cli demo, offline. Every reviewer and judge reply comes from the replay adapter; a
// trap `codex` (test/bin) is first on PATH so any spawn of codex leaves a log file and is caught.
// `node scripts/check.mjs --docker` reruns this file with `docker run --network none`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demo, EXAMPLE } from '../scripts/demo.mjs';
import { readEvents } from '../lib/ledger.mjs';
import { recordedRequests, recordPipeline, writeTranscripts } from '../scripts/record-live.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const EVENT_ORDER = [
  'plan.created',
  'round.opened', // review run opens round 1; review ingest (round 2) does not
  'review.submitted', 'review.submitted', // round 1: plan review by alpha and beta
  'judge.ruled',
  'build.recorded',
  'review.submitted', 'review.submitted', // round 2: correctness and acceptance lenses
  'verdict.issued',
];

// Runs the demo on `example` with the trap codex on PATH. Returns the ledger walk and whether codex ran.
async function runPipeline(example) {
  const tmp = mkdtempSync(join(tmpdir(), 'councilkit-e2e-'));
  const log = join(tmp, 'codex-spawned.json');
  const saved = { PATH: process.env.PATH, log: process.env.FAKE_CODEX_LOG, tr: process.env.FAKE_CODEX_TRANSCRIPT };
  // Child processes inherit process.env; on Windows the key is case-insensitive, so PATH covers Path.
  process.env.PATH = `${join(root, 'test', 'bin')}${delimiter}${saved.PATH}`;
  process.env.FAKE_CODEX_LOG = log;
  process.env.FAKE_CODEX_TRANSCRIPT = join(root, 'fixtures', 'codex', 'synthetic-error.jsonl');
  const dir = join(tmp, 'repo');
  try {
    let error = null;
    try {
      await demo(dir, () => {}, { example });
    } catch (e) {
      error = e;
    }
    const ledger = join(dir, '.councilkit', 'add-json', 'ledger.jsonl');
    return { error, codexSpawned: existsSync(log), walk: existsSync(ledger) ? readEvents(ledger) : null };
  } finally {
    process.env.PATH = saved.PATH;
    for (const [k, v] of [['FAKE_CODEX_LOG', saved.log], ['FAKE_CODEX_TRANSCRIPT', saved.tr]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

function assertPipeline({ error, codexSpawned, walk }) {
  assert.equal(codexSpawned, false, 'codex was spawned in replay mode');
  assert.equal(error, null, error?.message);
  assert.equal(walk?.ok, true, `ledger chain broken: ${walk?.reason}`);
  const { events } = walk;
  assert.deepEqual(events.map((e) => e.type), EVENT_ORDER);
  events.forEach((e, i) => assert.equal(e.prev, i === 0 ? `sha256:${'0'.repeat(64)}` : events[i - 1].hash));
  const rulings = events.filter((e) => e.type === 'judge.ruled');
  assert.equal(rulings.length, 1, 'judge calls');
  assert.deepEqual(rulings.flatMap((e) => e.data.contested), ['Acceptance|testability']);
  assert.equal(rulings[0].actor.adapter, 'replay');
  assert.equal(events.at(-1).data.verdict, 'approve');
}

test('the demo pipeline runs offline with replay only: event order, hash chain, 1 contested, 1 judge call, approve', async () => {
  assertPipeline(await runPipeline(EXAMPLE));
});

test('guard: the same check fails when the replay adapter is swapped for codex', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'councilkit-e2e-codex-'));
  try {
    cpSync(EXAMPLE, tmp, { recursive: true });
    const cfg = JSON.parse(readFileSync(join(tmp, 'councilkit.json'), 'utf8'));
    const swapped = { ...cfg, reviewers: cfg.reviewers.map((r) => ({ ...r, adapter: 'codex' })), judge: { ...cfg.judge, adapter: 'codex' } };
    writeFileSync(join(tmp, 'councilkit.json'), JSON.stringify(swapped));
    const result = await runPipeline(tmp);
    assert.equal(result.codexSpawned, true, 'the trap codex was not reached; the guard would miss a swap');
    assert.throws(() => assertPipeline(result), /codex was spawned/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('record-live --dry-run lists the three demo requests and spawns nothing', async () => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'record-live.mjs'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^codex: (found|not found) on PATH$/m);
  assert.equal(r.stdout.match(/^would record /gm)?.length, 3);
  assert.match(r.stdout, /dry run: 3 request\(s\), nothing spawned, nothing written/);
});

// A stand-in for codex: replays the stored transcripts, but beta's F1 comes back as `major`, and the
// judge gets the stored ruling whatever its prompt says (the contested key is unchanged).
async function changedReplies() {
  const { createReplayAdapter } = await import('../lib/adapters/replay.mjs');
  const replay = createReplayAdapter();
  const stored = recordedRequests().map(({ file }) => JSON.parse(readFileSync(join(EXAMPLE, 'fixtures', 'transcripts', file), 'utf8')));
  const judgeReply = stored.find((t) => t.request.role === 'judge').response;
  return {
    async run(request) {
      if (request.role === 'judge') return judgeReply;
      const reply = await replay.run(request);
      if (!request.prompt.includes('"reviewer": "beta"')) return reply;
      const json = { findings: reply.json.findings.map((f) => ({ ...f, severity: 'major' })) };
      return { ...reply, json, raw: JSON.stringify(json) };
    },
  };
}

test('record-live builds the judge request from the new reviewer replies, and the demo passes on them', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'councilkit-record-'));
  try {
    const recorded = await recordPipeline(await changedReplies());
    const oldJudge = recordedRequests().find((r) => r.request.role === 'judge').file;
    const judge = recorded.find((r) => r.role === 'judge');
    assert.equal(recorded.length, 3);
    assert.notEqual(judge.file, oldJudge, 'judge transcript kept the old key');
    assert.match(JSON.parse(judge.text).request.prompt, /"severity": "major"/);
    const example = join(tmp, 'example');
    cpSync(EXAMPLE, example, { recursive: true });
    const dir = join(example, 'fixtures', 'transcripts');
    const stale = writeTranscripts(recorded, dir, recordedRequests().map((r) => r.file));
    assert.deepEqual(stale, [oldJudge]);
    assert.equal(existsSync(join(dir, oldJudge)), false);
    assertPipeline(await runPipeline(example));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
