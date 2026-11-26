// councilkit command line. Returns the process exit code.
//   plan hash: 0 ok, 1 error or bad usage.
//   plan lint: 0 ok, 1 error or bad usage, 2 required section missing.
//   ledger:    0 ok, 1 I/O error, 2 bad usage or input, 3 ledger chain broken.
//   gate review, plan rebind: 0 ok, 2 blocked or bad usage/input, 3 ledger chain broken.
//   judge: 0 ruled, 1 adapter or reply failure, 2 stale plan or bad usage/input, 3 ledger chain broken.
//   panel: 0 ok, 1 git could not run, 2 bad usage, bad config, not a git repository or a git command failed.
// judge calls an adapter, so for it main returns a Promise of the exit code.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { planSha } from './plan-hash.mjs';
import { missingSections } from './plan-lint.mjs';
import { EVENT_TYPES, canonical, verify, append } from './ledger.mjs';
import { gateReview, rebindPlan, GateInputError } from './gate.mjs';
import { runJudge } from './judge.mjs';
import { changedLines, selectLenses, PanelError } from './panel.mjs';
import { loadConfig, ConfigError } from './config.mjs';

const USAGE = `usage: councilkit plan hash <file>
       councilkit plan lint <file>
       councilkit plan rebind --slug <s> --reason '<text>'
       councilkit gate review --slug <s>
       councilkit judge --slug <s> --round <n>
       councilkit panel --base <ref> [--json]
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
  const command = argv[0] === 'ledger' ? ledger
    : argv[0] === 'gate' ? gate
      : argv[0] === 'judge' ? judge
        : argv[0] === 'panel' ? panel
          : argv[0] === 'plan' && argv[1] === 'rebind' ? rebind : null;
  if (!command) return plan(argv, out, err);
  const onError = (e) => {
    if (!(e instanceof UsageError || e instanceof GateInputError || e instanceof PanelError
      || e instanceof ConfigError)) throw e;
    err.write(`councilkit: ${e.message}\n`);
    return 2;
  };
  try {
    const code = command(argv.slice(1), out, err);
    return code instanceof Promise ? code.catch(onError) : code;
  } catch (e) {
    return onError(e);
  }
}

function judge(args, out, err) {
  const values = options(args, { slug: { type: 'string' }, round: { type: 'string' } });
  const slug = slugOf(values);
  if (!/^[1-9]\d*$/.test(values.round ?? '')) throw new UsageError('--round must be an integer >= 1');
  return runJudge(slug, Number(values.round)).then((r) => report(r, out, err));
}

function panel(args, out, err) {
  const values = options(args, { base: { type: 'string' }, json: { type: 'boolean' } });
  if (!values.base) throw new UsageError('--base is required');
  const { tiers } = loadConfig(process.cwd()).panel;
  let diff;
  try {
    diff = changedLines(values.base);
  } catch (e) {
    if (e instanceof PanelError) throw e;
    err.write(`councilkit: ${e.message}
`);
    return 1;
  }
  const { tier, lenses } = selectLenses(diff.lines, tiers);
  if (values.json) {
    out.write(`${JSON.stringify({ changed_lines: diff.lines, tier, lenses, binary: diff.binary })}
`);
    return 0;
  }
  out.write(`${diff.lines} changed lines, tier ${tier}: ${lenses.join(', ')}
`);
  for (const file of diff.binary) out.write(`binary (counted as 0): ${file}
`);
  return 0;
}

function report({ code, out: stdout, err: stderr }, out, err) {
  out.write(stdout);
  err.write(stderr);
  return code;
}

function gate([command, ...args], out, err) {
  if (command !== 'review') throw new UsageError(`unknown gate command\n${USAGE}`);
  return report(gateReview(slugOf(options(args, { slug: { type: 'string' } }))), out, err);
}

function rebind([, ...args], out, err) {
  const values = options(args, { slug: { type: 'string' }, reason: { type: 'string' } });
  return report(rebindPlan(slugOf(values), values.reason), out, err);
}

function options(args, spec) {
  try {
    return parseArgs({ args, options: spec, strict: true }).values;
  } catch (e) {
    throw new UsageError(e.message);
  }
}

function slugOf({ slug }) {
  if (!slug) throw new UsageError('--slug is required');
  // The slug becomes a directory name: no separators, no leading dot, so it cannot escape .councilkit/.
  if (!SLUG_RE.test(slug)) throw new UsageError(`invalid --slug ${JSON.stringify(slug)} (letters, digits, . _ -)`);
  return slug;
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
  const values = options(args, LEDGER_OPTIONS);
  const slug = slugOf(values);
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
