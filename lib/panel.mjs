// Review panel sized by the diff: count changed lines with `git diff --numstat -z`, pick the first tier
// whose max_changed_lines is not exceeded (null = no upper bound).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// git ran and failed (CLI exit 2); NotARepoError is the "not a git repository" case of it.
export class PanelError extends Error {}
export class NotARepoError extends PanelError {
  constructor() { super('not a git repository'); }
}
// git could not start at all (CLI exit 1).
export class GitUnavailableError extends Error {}

export function git(args, cwd, env) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new GitUnavailableError(`cannot run git: ${r.error.message}`);
  if (r.status !== 0) {
    if (/not a git repository/i.test(r.stderr)) throw new NotARepoError();
    throw new PanelError(`git ${args[0]} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

// Added plus deleted lines since the merge base of base and head (head omitted = HEAD plus the working
// tree, untracked files included, ignored files left out), so commits made on base after the branch point
// do not count. Binary files (numstat prints `-` for both counts) count as 0 and are listed in `binary`.
export function changedLines(base, head, { cwd = process.cwd() } = {}) {
  for (const ref of [base, head]) {
    if (typeof ref === 'string' && ref.startsWith('-')) throw new PanelError(`ref ${JSON.stringify(ref)} must not start with "-"`);
  }
  const from = git(['merge-base', base, head ?? 'HEAD', '--'], cwd).trim();
  if (head !== undefined) return parseNumstat(git(['diff', '--numstat', '-z', from, head, '--'], cwd));
  // Untracked files enter the diff through `git add -N` on a copy of the index; the real index is untouched.
  const tmp = mkdtempSync(join(tmpdir(), 'councilkit-index-'));
  try {
    const index = resolve(cwd, git(['rev-parse', '--git-path', 'index'], cwd).trim());
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
    if (existsSync(index)) copyFileSync(index, env.GIT_INDEX_FILE);
    git(['add', '--intent-to-add', '--', ':/'], cwd, env);
    return parseNumstat(git(['diff', '--numstat', '-z', from, '--'], cwd, env));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
// -z records: "<added>\t<deleted>\t<path>\0", or for a rename/copy "<added>\t<deleted>\t\0<old>\0<new>\0".
export function parseNumstat(stdout) {
  const fields = stdout.split('\0');
  let lines = 0;
  const binary = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const [added, deleted, path] = fields[i].split('\t');
    const name = path || fields[(i += 2)]; // rename: skip old, take new
    if (added === '-' && deleted === '-') binary.push(name);
    else lines += Number(added) + Number(deleted);
  }
  return { lines, binary };
}

// tiers as validated by lib/config.mjs: ascending max_changed_lines, null only on the last tier.
export function selectLenses(lines, tiers) {
  const index = tiers.findIndex((t) => t.max_changed_lines === null || lines <= t.max_changed_lines);
  const i = index === -1 ? tiers.length - 1 : index; // no open-ended tier: larger diffs get the biggest panel
  return { tier: i + 1, lenses: [...tiers[i].lenses] };
}
