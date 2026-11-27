#!/usr/bin/env node
// Manual: re-records the demo's replay transcripts from a real `codex` (never run by scripts/check.mjs).
//   node scripts/record-live.mjs [--dry-run]
// It replays the demo's plan review and judge steps (lib/review-run.mjs, lib/judge.mjs) on a temporary
// git copy of examples/todo-cli, with the codex adapter behind a recorder. The judge prompt quotes the
// reviewers' findings, so the judge request is built from the new reviewer replies, never reused from
// the old transcript. Nothing is written unless every call succeeds and every transcript passes the
// redaction pass of scripts/record-transcript.mjs; then the old transcripts that were not re-recorded
// are deleted. A fresh reply can change the demo's output and its contested keys: rerun
// `node scripts/demo.mjs`, update docs/quickstart.md and test/e2e.test.mjs, then run `npm run check`.
// `--dry-run` lists the current transcripts and whether codex is on PATH, and spawns nothing.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter, findCodex, NOT_FOUND } from '../lib/adapters/codex.mjs';
import { TRANSCRIPT_DIR, requestKey } from '../lib/adapters/replay.mjs';
import { runReview } from '../lib/review-run.mjs';
import { runJudge } from '../lib/judge.mjs';
import { fixtureText } from './record-transcript.mjs';
import { EXAMPLE } from './demo.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'councilkit');
const SLUG = 'add-json';
const PLAN = `.councilkit/${SLUG}/plan.md`; // forward slashes, as in scripts/demo.mjs

export function recordedRequests(dir = join(EXAMPLE, TRANSCRIPT_DIR)) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((file) => ({ file, request: JSON.parse(readFileSync(join(dir, file), 'utf8')).request }));
}

function sh(cwd, command, args) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${r.error?.message ?? r.stderr}`);
}

// Runs plan review round 1 and its judge on a copy of `example` with `adapter` answering every call.
// Returns [{ file, text }] for the new transcripts, or throws before anything is written.
export async function recordPipeline(adapter, { example = EXAMPLE } = {}) {
  const calls = [];
  const recorder = {
    async run(request) {
      const reply = await adapter.run(request);
      if (!reply?.ok) throw new Error(`${request.role} call failed, transcripts kept: ${reply?.error ?? 'no reply'}`);
      calls.push({ request, reply });
      return reply;
    },
  };
  const work = mkdtempSync(join(tmpdir(), 'councilkit-live-'));
  try {
    cpSync(example, work, { recursive: true });
    // codex exec may refuse a working root outside a git repository (docs/codex.md), so make it one.
    sh(work, 'git', ['init', '--quiet']);
    mkdirSync(join(work, dirname(PLAN)), { recursive: true });
    cpSync(join(work, 'fixtures', 'plan.md'), join(work, PLAN));
    sh(work, process.execPath, [BIN, 'ledger', 'append', '--slug', SLUG, '--type', 'plan.created', '--data', JSON.stringify({ path: PLAN })]);
    // runReview turns a thrown call into verdict "error" and exit 1; runJudge lets the throw through.
    const review = await runReview(SLUG, { root: work, round: 1, adapterFor: () => recorder });
    if (review.code !== 0) throw new Error(`plan review failed, transcripts kept:\n${review.out}${review.err}`);
    const judge = await runJudge(SLUG, 1, { root: work, adapter: recorder });
    if (judge.code !== 0) throw new Error(`judge failed, transcripts kept: ${judge.err}`);
    if (!calls.some((c) => c.request.role === 'judge')) console.warn('record-live: no contested findings, so no judge transcript; the demo and test/e2e.test.mjs expect one');
    return calls.map(({ request, reply }) => ({ role: request.role, file: `${requestKey(request)}.json`, text: fixtureText(request, reply) }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Writes the new transcripts, then deletes those of the `old` file names that were not re-recorded.
export function writeTranscripts(recorded, outDir, old = []) {
  mkdirSync(outDir, { recursive: true });
  for (const { file, text } of recorded) writeFileSync(join(outDir, file), text);
  const kept = new Set(recorded.map((r) => r.file));
  const stale = old.filter((f) => !kept.has(f));
  for (const f of stale) rmSync(join(outDir, f), { force: true });
  return stale;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' } }, strict: true });
  const outDir = join(EXAMPLE, TRANSCRIPT_DIR);
  const requests = recordedRequests(outDir);
  const codex = findCodex(process.env);
  console.log(`codex: ${codex ? 'found on PATH' : 'not found on PATH'}`);
  if (values['dry-run']) {
    for (const { file, request } of requests) {
      console.log(`would record ${request.role}: ${file}${request.role === 'judge' ? ' (request rebuilt from the new reviewer replies)' : ''}`);
    }
    console.log(`dry run: ${requests.length} request(s), nothing spawned, nothing written`);
    return 0;
  }
  if (!codex) {
    console.error(`record-live: ${NOT_FOUND}`);
    return 1;
  }
  const recorded = await recordPipeline(createCodexAdapter({ sandbox: 'read-only' }));
  for (const { role, file } of recorded) console.log(`${role}: ${file}: redaction clean`);
  const stale = writeTranscripts(recorded, outDir, requests.map((r) => r.file));
  for (const f of stale) console.log(`deleted stale transcript ${f}`);
  console.log(`wrote ${recorded.length} transcript(s) to ${outDir}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`record-live: ${err.message}`);
    process.exitCode = 1;
  });
}
