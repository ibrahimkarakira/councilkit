// Codex adapter (roadmap D11): runs `codex exec` non-interactively as a reviewer or judge.
// argv: codex exec --json [--output-schema <tmp>] -o <tmp> --sandbox <mode> [-m <model>] -
// The prompt goes on stdin (`-`); the working root is the request's cwd (spawn cwd, so no --cd).
// stdout is JSONL; turn.failed and error events become ok:false with their message. The reply is the
// -o file (the last agent message), parsed as JSON. Flags and events: docs/codex.md.
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, extname, join } from 'node:path';
import { killTree } from '../build.mjs';

export const NOT_FOUND = 'codex not found on PATH; install it or switch adapter';
// danger-full-access is refused outright: a reviewer never needs to write outside the workspace.
const SANDBOXES = ['read-only', 'workspace-write'];
const DEFAULT_TIMEOUT_S = 600;
// cmd.exe treats these as syntax, so a .cmd shim is only started with arguments free of them.
const CMD_SAFE = /^[^"%!^&|<>\r\n]*$/;

const fail = (error, exit = null, raw = '') => ({ ok: false, json: null, raw, exit, error });

export function codexArgv(cfg, { schemaFile, lastFile }) {
  const sandbox = cfg.sandbox ?? 'read-only';
  if (!SANDBOXES.includes(sandbox)) throw new Error(`codex sandbox must be read-only or workspace-write, got ${JSON.stringify(sandbox)}`);
  return [
    'exec', '--json',
    ...(schemaFile ? ['--output-schema', schemaFile] : []),
    '-o', lastFile,
    '--sandbox', sandbox,
    ...(cfg.model ? ['-m', cfg.model] : []),
    '-',
  ];
}

// First codex on PATH: codex plus each PATHEXT extension on Windows, an executable `codex` elsewhere.
export function findCodex(env) {
  const win = process.platform === 'win32';
  const names = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => `codex${e.toLowerCase()}`) : ['codex'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      try {
        accessSync(join(dir, name), win ? constants.F_OK : constants.X_OK);
        return join(dir, name);
      } catch { /* not here */ }
    }
  }
  return null;
}

// Last failure message and last agent message in a JSONL stream; lines that are not JSON are skipped.
export function readEvents(stdout) {
  let failure = null;
  let message = null;
  for (const line of stdout.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type === 'turn.failed') failure = e.error?.message ?? 'turn failed';
    else if (e?.type === 'error') failure = e.message ?? 'codex error';
    else if (e?.type === 'item.completed' && e.item?.type === 'agent_message') message = e.item.text;
  }
  return { failure, message };
}

function exec(bin, argv, { cwd, env, input, timeoutMs }) {
  const shim = process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(bin).toLowerCase());
  if (shim && ![bin, ...argv].every((a) => CMD_SAFE.test(a))) {
    return Promise.resolve({ error: new Error('codex is a .cmd shim and an argument has a character cmd.exe would interpret') });
  }
  // Node refuses to start a .cmd without a shell; every argument is quoted and checked above.
  const [command, args] = shim ? [[bin, ...argv].map((a) => `"${a}"`).join(' '), []] : [bin, argv];
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, shell: shim, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.stdin.on('error', () => { /* child exited before reading stdin: reported by its exit */ });
    child.stdin.end(input);
    const done = (status, error) => {
      clearTimeout(timer);
      resolve({ status, error, timedOut, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    child.on('error', (e) => done(null, e));
    child.on('close', (code) => done(code, null));
  });
}

export function createCodexAdapter(cfg = {}, { env = process.env } = {}) {
  return {
    name: 'codex',
    async run(request) {
      try {
        return await runCodex(cfg, env, request);
      } catch (e) {
        return fail(`codex adapter: ${e.message}`);
      }
    },
  };
}

// The run itself; anything it throws (temp dir, schema file) becomes ok:false in run above.
async function runCodex(cfg, env, request) {
  const bin = findCodex(env);
  if (!bin) return fail(NOT_FOUND);
  const tmp = mkdtempSync(join(tmpdir(), 'councilkit-codex-'));
  try {
    const schemaFile = request.schema ? join(tmp, 'schema.json') : null;
    const lastFile = join(tmp, 'last-message.txt');
    let argv;
    try {
      argv = codexArgv(cfg, { schemaFile, lastFile });
    } catch (e) {
      return fail(e.message);
    }
    if (schemaFile) writeFileSync(schemaFile, JSON.stringify(request.schema));
    const timeoutS = request.timeout_s ?? cfg.timeout_s ?? DEFAULT_TIMEOUT_S;
    const r = await exec(bin, argv, { cwd: request.cwd ?? process.cwd(), env, input: request.prompt ?? '', timeoutMs: timeoutS * 1000 });
    if (r.error) return fail(`could not start codex: ${r.error.message}`);
    if (r.timedOut) return fail(`codex timed out after ${timeoutS} s`, r.status);
    const { failure, message } = readEvents(r.stdout);
    if (failure) return fail(failure, r.status);
    if (r.status !== 0) return fail(`codex exited with code ${r.status}: ${r.stderr.trim().split('\n').pop() ?? ''}`, r.status);
    let raw = message ?? '';
    try {
      raw = readFileSync(lastFile, 'utf8') || raw;
    } catch { /* no -o file: fall back to the last agent_message event */ }
    try {
      return { ok: true, json: JSON.parse(raw), raw, exit: r.status };
    } catch {
      return fail('codex reply is not JSON', r.status, raw);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
