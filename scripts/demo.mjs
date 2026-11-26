#!/usr/bin/env node
// The whole councilkit pipeline on the invented examples/todo-cli project, with no model: every
// reviewer and judge reply comes from a recorded transcript through the replay adapter.
//   node scripts/demo.mjs
// It copies the example into a temporary git repository, then runs plan, plan review, judge, build,
// panel, verdict and report through bin/councilkit, and ends with `verify: ok` when the ledger chain
// checks out. Only stable lines are printed (no timestamps, commit SHAs or durations), so
// docs/quickstart.md can show the exact output and test/demo.test.mjs diffs the two.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { normalisePlan } from '../lib/plan-hash.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'examples', 'todo-cli');
const BIN = join(ROOT, 'bin', 'councilkit');
const SLUG = 'add-json';
const PLAN = `.councilkit/${SLUG}/plan.md`; // forward slashes on every OS, so the output is the same
const GIT_ID = ['-c', 'user.name=councilkit demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false'];

// ponytail: a stand-in plan-review request until the plan review skill (#18) defines the real
// prompt; when it lands, re-record the two reviewer transcripts with scripts/record-transcript.mjs.
export const REVIEW_SCHEMA = Object.freeze({ type: 'object', required: ['verdict', 'findings'] });
export const reviewRequest = (id, plan) => ({
  role: 'reviewer',
  prompt: `You are plan reviewer ${id}. Review this plan and reply with JSON only: {"verdict", "findings"}.\n\n${normalisePlan(plan)}`,
  schema: REVIEW_SCHEMA,
});

class DemoError extends Error {}

function sh(cwd, command, args, expect = 0) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (r.error) throw new DemoError(`cannot run ${command}: ${r.error.message}`);
  if (r.status !== expect) {
    throw new DemoError(`${command} ${args.join(' ')} exited ${r.status}, expected ${expect}\n${r.stdout}${r.stderr}`);
  }
  return r.stdout;
}

const git = (cwd, ...args) => sh(cwd, 'git', [...GIT_ID, ...args]);
const ck = (cwd, ...args) => sh(cwd, process.execPath, [BIN, ...args]);
const appended = (stdout) => JSON.parse(stdout);
const counts = (findings) => {
  const by = Object.groupBy(findings, (f) => f.severity);
  return Object.entries(by).map(([s, list]) => `${list.length} ${s}`).join(', ') || '0 findings';
};

async function planReview(dir, plan, say) {
  const { reviewers } = loadConfig(dir);
  for (const reviewer of reviewers) {
    const reply = await getAdapter(reviewer).run({ ...reviewRequest(reviewer.id, plan), cwd: dir, timeout_s: reviewer.timeout_s ?? 600 });
    if (!reply.ok) throw new DemoError(`reviewer ${reviewer.id}: ${reply.error}`);
    const { verdict, findings } = reply.json;
    const data = JSON.stringify({ reviewer: reviewer.id, round: 1, verdict, findings });
    const actor = JSON.stringify({ role: 'reviewer', adapter: reviewer.adapter, model: reviewer.model ?? null });
    ck(dir, 'ledger', 'append', '--slug', SLUG, '--type', 'review.submitted', '--data', data, '--actor', actor);
    say(`${reviewer.id}: ${verdict} (${counts(findings)})`);
  }
}

async function demo(dir, say) {
  cpSync(EXAMPLE, dir, { recursive: true });
  git(dir, 'init', '--quiet');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'todo-cli');
  const base = git(dir, 'rev-parse', 'HEAD').trim();

  say('== plan');
  mkdirSync(join(dir, dirname(PLAN)), { recursive: true });
  cpSync(join(dir, 'fixtures', 'plan.md'), join(dir, PLAN));
  say(ck(dir, 'plan', 'lint', PLAN).trimEnd());
  const created = appended(ck(dir, 'ledger', 'append', '--slug', SLUG, '--type', 'plan.created', '--data', JSON.stringify({ path: PLAN })));
  say(`plan.created seq ${created.seq}, plan_sha ${created.plan_sha}`);

  say('\n== plan review (round 1, replay)');
  await planReview(dir, readFileSync(join(dir, PLAN), 'utf8'), say);

  say('\n== judge (round 1, replay)');
  say(ck(dir, 'judge', '--slug', SLUG, '--round', '1').trimEnd());

  say('\n== build');
  ck(dir, 'gate', 'review', '--slug', SLUG);
  git(dir, 'apply', join('fixtures', 'build.patch'));
  git(dir, 'commit', '--quiet', '-am', 'list --json');
  const build = appended(ck(dir, 'build', 'record', '--slug', SLUG, '--base', base, '--test', 'node --test'));
  say(`build.recorded seq ${build.seq}: diff_lines ${build.data.diff_lines}, exit ${build.data.exit}`);
  ck(dir, 'gate', 'merge', '--slug', SLUG);
  say('gate merge: ok');

  say('\n== panel (round 2, recorded lens replies)');
  const panel = JSON.parse(ck(dir, 'panel', '--base', base, '--json'));
  say(`${panel.changed_lines} changed lines, tier ${panel.tier}: ${panel.lenses.join(', ')}`);
  for (const lens of panel.lenses) {
    const file = join('fixtures', 'panel', `${lens}.json`);
    const line = appended(ck(dir, 'review', 'ingest', '--slug', SLUG, '--lens', lens, '--round', '2', '--file', file));
    say(`${lens}: ${line.data.verdict} (${counts(line.data.findings)})`);
  }

  say('\n== verdict');
  say(ck(dir, 'verdict', '--slug', SLUG).trimEnd());

  say('\n== report');
  // The chain head hash covers timestamps, so it differs on every run; the rest of the report does not.
  say(ck(dir, 'report', '--slug', SLUG).split('\n').filter((l) => !l.startsWith('chain head:')).join('\n').trimEnd());

  say('');
  ck(dir, 'ledger', 'verify', '--slug', SLUG);
  say('verify: ok');
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'councilkit-demo-'));
  try {
    console.log('councilkit demo: examples/todo-cli in a temporary git repository, replay adapter, no model\n');
    await demo(dir, (line) => console.log(line));
    return 0;
  } catch (e) {
    if (!(e instanceof DemoError)) throw e;
    console.error(`demo: ${e.message}`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
