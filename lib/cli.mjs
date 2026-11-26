// councilkit command line. Returns the process exit code.
//   plan hash: 0 ok, 1 error or bad usage.
//   plan lint: 0 ok, 1 error or bad usage, 2 required section missing.
//   ledger:    0 ok, 1 I/O error, 2 bad usage or input, 3 ledger chain broken.
//   gate review, gate merge, plan rebind: 0 ok, 2 blocked or bad usage/input, 3 ledger chain broken.
//   build record: 0 recorded and the test passed, 1 recorded and the test failed or timed out (or git
//     could not run), 2 bad usage or input, 3 ledger chain broken.
//   judge: 0 ruled, 1 adapter or reply failure, 2 stale plan or bad usage/input, 3 ledger chain broken.
//   review ingest: 0 recorded, 1 recorded as verdict "error", 2 bad usage or input, 3 ledger chain broken.
//   verdict: 0 approve, 2 changes or bad usage/input, 3 ledger chain broken; appends verdict.issued.
//   report: 0 printed, 2 bad usage or no ledger, 3 ledger chain broken.
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
import { changedLines, selectLenses, PanelError, GitUnavailableError } from './panel.mjs';
import { ingestReview } from './review-ingest.mjs';
import { recordBuild, gateMerge, DEFAULT_TIMEOUT_S } from './build.mjs';
import { loadConfig, ConfigError } from './config.mjs';
import { issueVerdict } from './verdict.mjs';
import { renderReport } from './report.mjs';

const USAGE = `usage: councilkit plan hash <file>
       councilkit plan lint <file>
       councilkit plan rebind --slug <s> --reason '<text>'
       councilkit gate review --slug <s>
       councilkit gate merge --slug <s>
       councilkit build record --slug <s> --base <ref> --test '<cmd>' [--timeout <seconds>]
       councilkit judge --slug <s> --round <n>
       councilkit verdict --slug <s>
       councilkit report --slug <s> [--md]
       councilkit panel --base <ref> [--json]
       councilkit review ingest --slug <s> --lens <name> --round <n> [--file <path>]
       councilkit ledger append --slug <s> --type <t> --data '<json>' [--plan <file>] [--actor '<json>']
       councilkit ledger show --slug <s>
       councilkit ledger verify --slug <s>`;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LENS_RE = /^[a-z][a-z0-9-]*$/;
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
          : argv[0] === 'review' ? review
          : argv[0] === 'build' ? build
          : argv[0] === 'verdict' ? verdict
          : argv[0] === 'report' ? reportCmd
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

// Lens output comes from --file, else stdin.
function review([command, ...args], out, err) {
  if (command !== 'ingest') throw new UsageError(`unknown review command
${USAGE}`);
  const values = options(args, { slug: { type: 'string' }, lens: { type: 'string' }, round: { type: 'string' }, file: { type: 'string' } });
  const slug = slugOf(values);
  if (!LENS_RE.test(values.lens ?? '')) throw new UsageError('--lens must be lowercase letters, digits and -');
  if (!/^[1-9]\d*$/.test(values.round ?? '')) throw new UsageError('--round must be an integer >= 1');
  let text;
  try {
    text = readFileSync(values.file ?? 0, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${values.file ?? 'stdin'}: ${e.code ?? e.message}`);
  }
  return report(ingestReview(slug, values.lens, Number(values.round), text), out, err);
}

function panel(args, out, err) {
  const values = options(args, { base: { type: 'string' }, json: { type: 'boolean' } });
  if (!values.base) throw new UsageError('--base is required');
  const { tiers } = loadConfig(process.cwd()).panel;
  let diff;
  try {
    diff = changedLines(values.base);
  } catch (e) {
    return gitUnavailable(e, err);
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
  if (!['review', 'merge'].includes(command)) throw new UsageError(`unknown gate command\n${USAGE}`);
  const slug = slugOf(options(args, { slug: { type: 'string' } }));
  return command === 'review' ? report(gateReview(slug), out, err) : withGit(() => gateMerge(slug), out, err);
}

// The test command runs through the shell as given: it comes from the person running the CLI.
function build([command, ...args], out, err) {
  if (command !== 'record') throw new UsageError(`unknown build command\n${USAGE}`);
  const values = options(args, { slug: { type: 'string' }, base: { type: 'string' }, test: { type: 'string' }, timeout: { type: 'string' } });
  const slug = slugOf(values);
  if (!values.base) throw new UsageError('--base is required');
  if (!values.test?.trim()) throw new UsageError('--test is required');
  if (values.timeout !== undefined && !/^[1-9]\d*$/.test(values.timeout)) throw new UsageError('--timeout must be an integer >= 1 (seconds)');
  const timeoutS = values.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(values.timeout);
  return withGit(() => recordBuild(slug, { base: values.base, test: values.test, timeoutS }), out, err);
}

// git that could not start at all is exit 1; git that ran and failed is a PanelError (2, via main).
function gitUnavailable(e, err) {
  if (!(e instanceof GitUnavailableError)) throw e;
  err.write(`councilkit: ${e.message}\n`);
  return 1;
}

function withGit(run, out, err) {
  const cannotRun = (e) => gitUnavailable(e, err);
  try {
    const r = run();
    return r instanceof Promise ? r.then((x) => report(x, out, err), cannotRun) : report(r, out, err);
  } catch (e) {
    return cannotRun(e);
  }
}

function verdict(args, out, err) {
  const slug = slugOf(options(args, { slug: { type: 'string' } }));
  return withGit(() => issueVerdict(slug), out, err);
}

function reportCmd(args, out, err) {
  const values = options(args, { slug: { type: 'string' }, md: { type: 'boolean' } });
  return report(renderReport(slugOf(values), { md: values.md }), out, err);
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
