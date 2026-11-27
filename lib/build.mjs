// Build recorder (roadmap D17): ties a tested diff to the ledger, and the merge gate that needs it.
// build.recorded data: base_sha, head_sha, diff_lines, test_cmd, exit, timed_out, duration_ms and
// output_sha256 (SHA-256 of the test's stdout followed by its stderr; the output itself is not kept).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { planSha } from './plan-hash.mjs';
import { append } from './ledger.mjs';
import { files, readPlan, load, lastAnchor, checkReview, GateInputError } from './gate.mjs';
import { git, changedLines, PanelError, NotARepoError } from './panel.mjs';
import { roundCap, rulesOf } from './rounds.mjs';

export const DEFAULT_TIMEOUT_S = 600;
const BUILD_ACTOR = Object.freeze({ role: 'build', adapter: 'councilkit', model: null });
const GATE_ACTOR = Object.freeze({ role: 'gate', adapter: 'councilkit', model: null });

// Full commit SHA of a ref; the ref can never be read as an option.
export const commitOf = (ref, cwd) => git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], cwd).trim();

function resolveCommit(ref, cwd) {
  try {
    return commitOf(ref, cwd);
  } catch (e) {
    // --quiet leaves stderr empty for a ref that does not exist, so name it here.
    if (!(e instanceof PanelError) || e instanceof NotARepoError) throw e;
    throw new GateInputError(`--base ${JSON.stringify(ref)} is not a commit`);
  }
}

// Killing the shell alone would leave what it started running (Windows cmd.exe, or sh with a
// compound command), so the whole tree goes: taskkill /T on Windows, the process group elsewhere.
export function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
}

// Runs `cmd` through the platform shell (sh, or cmd.exe on Windows) with no stdin.
// ponytail: output is buffered in memory to hash stdout then stderr; stream-hash if outputs get huge.
export function runTest(cmd, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on('data', (c) => stdout.push(c));
    child.stderr.on('data', (c) => stderr.push(c));
    const done = (status, signal, error) => {
      clearTimeout(timer);
      resolve({ status, signal, error, timedOut, output: Buffer.concat([...stdout, ...stderr]) });
    };
    child.on('error', (e) => done(null, null, e));
    child.on('close', (code, signal) => done(code, signal, null));
  });
}

// Runs `test` in `root` and records it. Resolves { code, out, err }: 0 recorded and the test passed,
// 1 recorded and the test failed or timed out, 3 broken ledger.
// Bad input (plan, base ref, not a git repository, uncommitted changes) throws before anything runs.
export async function recordBuild(slug, { base, test, timeoutS = DEFAULT_TIMEOUT_S, root = '.' }) {
  const f = files(slug, root);
  const sha = planSha(readPlan(f.plan));
  const { broken } = load(f.ledger);
  if (broken) return broken;
  const baseSha = resolveCommit(base, root);
  const headSha = commitOf('HEAD', root);
  const diffLines = changedLines(baseSha, headSha, { cwd: root }).lines;
  // The result is recorded for HEAD, so uncommitted work would be tested but not recorded. The ledger
  // itself lives in .councilkit/ and changes on every append, so it does not count.
  const dirty = git(['status', '--porcelain', '--', ':/', ':(top,exclude).councilkit'], root).split('\n').filter(Boolean);
  if (dirty.length) throw new GateInputError(`working tree has ${dirty.length} uncommitted change(s); commit them first, the build is recorded for HEAD`);

  const started = performance.now();
  const r = await runTest(test, { cwd: root, timeoutMs: timeoutS * 1000 });
  const durationMs = Math.round(performance.now() - started);
  const data = {
    base_sha: baseSha,
    head_sha: headSha,
    diff_lines: diffLines,
    test_cmd: test,
    exit: r.status,
    timed_out: r.timedOut,
    duration_ms: durationMs,
    output_sha256: `sha256:${createHash('sha256').update(r.output).digest('hex')}`,
  };
  const line = append(f.ledger, { type: 'build.recorded', plan_sha: sha, actor: { ...BUILD_ACTOR }, data });
  const out = `${JSON.stringify(line)}\n`;
  if (data.exit === 0) return { code: 0, out, err: '' };
  const why = data.timed_out ? `timed out after ${timeoutS} s` : r.error ? `failed: ${r.error.code ?? r.error.message}` : `exited ${data.exit ?? r.signal}`;
  return { code: 1, out, err: `councilkit: build record: test command ${why}; recorded\n` };
}

// The review gate, the fix-round cap (rounds.mjs), plus a passing build.recorded for the current HEAD since the plan of record.
// { code, out, err }: 0 ok, 2 blocked (one gate.blocked appended), 3 broken ledger.
export function gateMerge(slug, { root = '.' } = {}) {
  const f = files(slug, root);
  const { broken, got, events, expected, reason } = checkReview(slug, { root });
  if (broken) return broken;
  // The fix-round cap is checked before git, so it blocks even outside a repository.
  const cap = reason ? null : roundCap(events.slice(lastAnchor(events) + 1), expected, rulesOf(root), slug);
  if (cap) {
    append(f.ledger, { type: 'gate.blocked', plan_sha: got, actor: { ...GATE_ACTOR }, data: { gate: 'merge', ...cap.data, expected, got, head: null } });
    return { code: 2, out: '', err: `councilkit: gate merge blocked: ${cap.message}\n` };
  }
  const head = reason ? null : commitOf('HEAD', root);
  const why = reason ?? buildReason(events, head);
  if (why) {
    append(f.ledger, { type: 'gate.blocked', plan_sha: got, actor: { ...GATE_ACTOR }, data: { gate: 'merge', expected, got, head, reason: why } });
    return { code: 2, out: '', err: `councilkit: gate merge blocked: ${why}\n` };
  }
  const build = latestBuild(events, head);
  return { code: 0, out: `ok: plan ${got} build seq ${build.seq} head ${head}\n`, err: '' };
}

const latestBuild = (events, head) => events.slice(lastAnchor(events) + 1)
  .findLast((e) => e.type === 'build.recorded' && e.data.head_sha === head);

// Why the build blocks a merge for `head`, or null. lib/verdict.mjs applies the same check.
export function buildReason(events, head) {
  const build = latestBuild(events, head);
  if (!build) return `no build.recorded for head ${head} since the plan of record`;
  if (build.data.exit !== 0) return `build at seq ${build.seq} for head ${head} exited ${build.data.exit}`;
  return null;
}
