#!/usr/bin/env node
// The whole councilkit pipeline on the invented examples/todo-cli project, with no model: every
// reviewer and judge reply comes from a recorded transcript through the replay adapter.
//   node scripts/demo.mjs
// It copies the example into a temporary git repository, then runs plan, plan review, judge, build,
// panel, verdict and report through bin/councilkit, and ends with `verify: ok` when the ledger chain
// checks out. Only stable lines are printed (no timestamps, commit SHAs or durations), so
// docs/quickstart.md can show the exact output and test/demo.test.mjs diffs the two.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { counts } from '../lib/review-run.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXAMPLE = join(ROOT, 'examples', 'todo-cli');
const BIN = join(ROOT, 'bin', 'councilkit');
const SLUG = 'add-json';
const PLAN = `.councilkit/${SLUG}/plan.md`; // forward slashes on every OS, so the output is the same
const GIT_ID = ['-c', 'user.name=councilkit demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false'];

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

// `example` is the project copied into `dir`; test/e2e.test.mjs swaps in a variant for its guard.
export async function demo(dir, say, { example = EXAMPLE } = {}) {
  cpSync(example, dir, { recursive: true });
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
  say(ck(dir, 'review', 'run', '--slug', SLUG, '--target', 'plan').trimEnd());

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
