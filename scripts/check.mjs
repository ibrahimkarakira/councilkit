#!/usr/bin/env node
// Local check suite (no hosted CI in this repo). Runs in order, stops on the first failure:
//   1. lint: `node --check` on every .mjs file
//   2. tests: `node --test`
//   3. plugin: `claude plugin validate --strict .`
// `--docker` instead reruns `node --test` in node:22 and node:24 Linux containers, then
// test/e2e.test.mjs with `--network none`, so "offline" is enforced rather than assumed.
// `--hashes` prints the platform and the plan hash of each HASH_FIXTURES file; the local run and
// each Docker image print it, so the per-OS hashes can be compared line by line.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planSha } from '../lib/plan-hash.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.councilkit']);
const DOCKER_IMAGES = ['node:22', 'node:24'];
export const HASH_FIXTURES = ['fixtures/plan-ok.md', 'fixtures/plan-crlf.md', 'fixtures/plan-unicode.md', 'fixtures/plan-unicode-crlf.md'];

function hashes(root) {
  console.log(`hashes: ${process.platform} node ${process.version}`);
  for (const rel of HASH_FIXTURES) console.log(`${planSha(readFileSync(join(root, rel), 'utf8'))} ${rel}`);
  return true;
}

export function listMjs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : listMjs(path);
    return entry.name.endsWith('.mjs') ? [path] : [];
  });
}

// Returns the files that failed the syntax check (empty array = all good).
export function lint(files, onError = (stderr) => process.stderr.write(stderr)) {
  return files.filter((file) => {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) onError(r.stderr);
    return r.status !== 0;
  });
}

function run(label, command, args, opts = {}) {
  console.log(`\n== ${label}: ${[command, ...args].join(' ')}`);
  const r = spawnSync(command, args, { stdio: 'inherit', ...opts });
  if (r.error) console.error(`${label}: could not start ${command}: ${r.error.message}`);
  return r.status === 0;
}

function local(root) {
  const files = listMjs(root);
  console.log(`== lint: node --check on ${files.length} .mjs file(s)`);
  const failed = lint(files);
  if (failed.length) {
    console.error(`lint failed: ${failed.join(', ')}`);
    return false;
  }
  if (!run('test', process.execPath, ['--test'], { cwd: root })) return false;
  console.log('\n== hashes');
  hashes(root);
  // Windows installs may expose `claude` as a .cmd shim, which needs a shell; the command is a constant.
  return run('plugin', 'claude plugin validate --strict .', [], { cwd: root, shell: true });
}

// The docker argv lists `--docker` runs, in order.
export function dockerRuns(root) {
  const base = (image, ...extra) => ['run', '--rm', ...extra, '-v', `${root}:/app`, '-w', '/app', image, 'node'];
  return [
    ...DOCKER_IMAGES.flatMap((image) => [[...base(image), '--test'], [...base(image), 'scripts/check.mjs', '--hashes']]),
    [...base(DOCKER_IMAGES[0], '--network', 'none'), '--test', 'test/e2e.test.mjs'],
  ];
}

function docker(root) {
  return dockerRuns(root).every((args) => run('docker', 'docker', args));
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (argv.includes('--hashes')) return hashes(root) ? 0 : 1;
  const ok = argv.includes('--docker') ? docker(root) : local(root);
  console.log(ok ? '\ncheck: all steps passed' : '\ncheck: FAILED');
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
