// councilkit command line. Returns the process exit code.
//   plan hash: 0 ok, 1 error or bad usage.
//   plan lint: 0 ok, 1 error or bad usage, 2 required section missing.
//   ledger:    0 ok, 1 I/O error, 2 bad usage or input, 3 ledger chain broken.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { planSha } from './plan-hash.mjs';
import { missingSections } from './plan-lint.mjs';
import { EVENT_TYPES, canonical, verify, append } from './ledger.mjs';

const USAGE = `usage: councilkit plan hash <file>
       councilkit plan lint <file>
       councilkit ledger append --slug <s> --type <t> --data '<json>' [--plan <file>] [--actor '<json>']
       councilkit ledger show --slug <s>
       councilkit ledger verify --slug <s>`;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_ACTOR = Object.freeze({ role: 'cli', adapter: 'councilkit', model: null });
const LEDGER_OPTIONS = {
  slug: { type: 'string' }, type: { type: 'string' }, data: { type: 'string' },
  plan: { type: 'string' }, actor: { type: 'string' },
};

class UsageError extends Error {}

export function main(argv, out = process.stdout, err = process.stderr) {
  if (argv[0] === 'ledger') {
    try {
      return ledger(argv.slice(1), out, err);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      err.write(`councilkit: ${e.message}\n`);
      return 2;
    }
  }
  return plan(argv, out, err);
}

function plan(argv, out, err) {
  const [group, command, file, ...rest] = argv;
  if (group !== 'plan' || !['hash', 'lint'].includes(command) || !file || rest.length) {
    err.write(`${USAGE}\n`);
    return 1;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    err.write(`councilkit: cannot read ${file}: ${e.code ?? e.message}\n`);
    return 1;
  }
  if (command === 'hash') {
    out.write(`${planSha(text)}\n`);
    return 0;
  }
  const missing = missingSections(text);
  for (const name of missing) err.write(`councilkit: ${file}: missing section: ## ${name}\n`);
  if (missing.length) return 2;
  out.write(`ok: ${file}\n`);
  return 0;
}

function ledger([command, ...args], out, err) {
  if (!['append', 'show', 'verify'].includes(command)) throw new UsageError(`unknown ledger command\n${USAGE}`);
  let values;
  try {
    ({ values } = parseArgs({ args, options: LEDGER_OPTIONS, strict: true }));
  } catch (e) {
    throw new UsageError(e.message);
  }
  const { slug } = values;
  if (!slug) throw new UsageError('--slug is required');
  // The slug becomes a directory name: no separators, no leading dot, so it cannot escape .councilkit/.
  if (!SLUG_RE.test(slug)) throw new UsageError(`invalid --slug ${JSON.stringify(slug)} (letters, digits, . _ -)`);
  const dir = join('.councilkit', slug);
  const file = join(dir, 'ledger.jsonl');

  if (command === 'show') {
    out.write(existsSync(file) ? readFileSync(file, 'utf8') : '');
    return 0;
  }
  const event = command === 'append' ? parseEvent(values, dir) : null; // bad input is 2, before the chain
  const state = verify(file);
  if (!state.ok) {
    err.write(`councilkit: ${file}: line ${state.line}: ${state.reason}\n`);
    return 3;
  }
  if (command === 'verify') {
    out.write(`ok: ${state.line} line${state.line === 1 ? '' : 's'}\n`);
    return 0;
  }
  try {
    out.write(`${JSON.stringify(append(file, event))}\n`);
  } catch (e) {
    err.write(`councilkit: cannot append to ${file}: ${e.code ?? e.message}\n`);
    return 1;
  }
  return 0;
}

// Validates every append input up front so nothing is written on bad input.
function parseEvent({ type, data, plan, actor }, dir) {
  if (!EVENT_TYPES.includes(type)) {
    throw new UsageError(`unknown --type ${JSON.stringify(type ?? '')}; valid types: ${EVENT_TYPES.join(', ')}`);
  }
  if (data === undefined) throw new UsageError('--data is required');
  const planFile = plan ?? join(dir, 'plan.md');
  let planText;
  try {
    planText = readFileSync(planFile, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read plan ${planFile}: ${e.code ?? e.message}`);
  }
  return {
    type,
    plan_sha: planSha(planText),
    data: jsonObject('--data', data),
    actor: actor === undefined ? { ...DEFAULT_ACTOR } : jsonObject('--actor', actor),
  };
}

function jsonObject(flag, text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${flag} is not valid JSON: ${e.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError(`${flag} must be a JSON object`);
  }
  try {
    canonical(value);
  } catch (e) {
    throw new UsageError(`${flag}: ${e.message}`);
  }
  return value;
}
