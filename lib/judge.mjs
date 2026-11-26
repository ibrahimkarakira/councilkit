// The judge (roadmap section 3.7): one adapter call per round, and only for contested findings.
// Uncontested findings never reach it; with nothing contested the adapter is not called at all and
// the ledger records judge.ruled with contested: [] and ruling: "none". Each ruling on a contested
// key becomes its own judge.ruled event; a "needs-human" ruling makes `gate review` block.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSha } from './plan-hash.mjs';
import { append } from './ledger.mjs';
import { contestGroups } from './findings.mjs';
import { loadConfig, ConfigError } from './config.mjs';
import { getAdapter } from './adapters/index.mjs';
import { files, readPlan, load, lastAnchor, GateInputError } from './gate.mjs';

export const RULINGS = ['uphold', 'dismiss', 'needs-human'];
export const JUDGE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['rulings'],
  properties: {
    rulings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'ruling', 'reason'],
        properties: { key: { type: 'string' }, ruling: { enum: RULINGS }, reason: { type: 'string' } },
      },
    },
  },
});
const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'judge.md');

// The body of `## <heading>` in the plan (heading line included), or null when there is none.
export function planSection(plan, heading) {
  const lines = plan.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n').trim();
}

// `contested` = contest groups ({ key, findings }) the judge must rule on; nothing else is sent.
// Reviewer text is data: it travels inside one JSON block, with backticks escaped so a claim
// cannot close the fence.
export function buildJudgeRequest(contested, plan, template = readFileSync(PROMPT_FILE, 'utf8')) {
  const plan_sections = {};
  for (const anchor of new Set(contested.flatMap((g) => g.findings.map((f) => f.anchor)))) {
    const text = planSection(plan, anchor);
    if (text !== null) plan_sections[anchor] = text;
  }
  const input = { contested: contested.map(({ key, findings }) => ({ key, findings })), plan_sections };
  const json = JSON.stringify(input, null, 2).replace(/`/g, '\\u0060');
  return { role: 'judge', prompt: `${template.trimEnd()}\n\n\`\`\`json\n${json}\n\`\`\`\n`, schema: JUDGE_SCHEMA };
}

// The rulings from the judge's JSON, exactly one per contested key, or a thrown Error.
export function parseRulings(json, keys) {
  const rulings = json?.rulings;
  if (!Array.isArray(rulings)) throw new Error('reply has no rulings array');
  const byKey = new Map();
  for (const r of rulings) {
    if (!keys.includes(r?.key)) throw new Error(`ruling for unknown key ${JSON.stringify(r?.key)}`);
    if (byKey.has(r.key)) throw new Error(`two rulings for ${r.key}`);
    if (!RULINGS.includes(r.ruling)) throw new Error(`ruling must be one of ${RULINGS.join(', ')}, got ${JSON.stringify(r.ruling)}`);
    if (typeof r.reason !== 'string' || !r.reason.trim()) throw new Error(`ruling for ${r.key} has no reason`);
    byKey.set(r.key, { key: r.key, ruling: r.ruling, reason: r.reason.trim() });
  }
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length) throw new Error(`no ruling for ${missing.join(', ')}`);
  return keys.map((k) => byKey.get(k));
}

// review.submitted events of `round` bound to the plan of record, as findings.mjs reviews.
// The reviewer name is data.reviewer, else the actor's adapter.
function reviewsOf(events, round, sha) {
  return events
    .filter((e) => e.type === 'review.submitted' && e.data.round === round && e.plan_sha === sha)
    .map(({ data, actor }) => {
      const review = { reviewer: data.reviewer ?? actor?.adapter, findings: Array.isArray(data.findings) ? data.findings : [] };
      for (const k of ['disputes', 'rebuttals']) if (k in data) review[k] = data[k];
      return review;
    });
}

// The contest groups of `round`'s reviews; malformed reviews are a GateInputError. Shared with verdict.mjs
// so the judge and the verdict group the same reviews the same way.
export function roundGroups(events, round, sha, rules) {
  try {
    return contestGroups(reviewsOf(events, round, sha), rules);
  } catch (e) {
    if (e instanceof TypeError) throw new GateInputError(`round ${round} reviews: ${e.message}`);
    throw e;
  }
}

const fail = (code, message) => ({ code, out: '', err: `councilkit: judge: ${message}\n` });

// { code, out, err }: 0 ruled, 1 adapter or reply failure (nothing appended), 2 bad input or stale
// plan (adapter not called), 3 broken ledger. `adapter` and `config` are injectable for tests.
export async function runJudge(slug, round, { root = '.', adapter, config } = {}) {
  const f = files(slug, root);
  const plan = readPlan(f.plan);
  const { events, broken } = load(f.ledger);
  if (broken) return broken;
  const i = lastAnchor(events);
  if (i < 0) return fail(2, 'no plan.created or plan.rebound in the ledger');
  const sha = events[i].plan_sha;
  const got = planSha(plan);
  if (got !== sha) return fail(2, `plan changed since last review: expected ${sha} got ${got}; review again or run councilkit plan rebind`);

  let cfg = config;
  try {
    cfg ??= loadConfig(root);
  } catch (e) {
    if (e instanceof ConfigError) throw new GateInputError(e.message);
    throw e;
  }
  const groups = roundGroups(events.slice(i + 1), round, sha, cfg.rules);
  const contested = groups.filter((g) => g.contested);
  const summary = `contested: ${contested.length} of ${groups.length}  uncontested: ${groups.length - contested.length}\n`;
  const actor = { role: 'judge', adapter: cfg.judge.adapter, model: cfg.judge.model ?? null };
  const record = (data) => append(f.ledger, { type: 'judge.ruled', plan_sha: sha, actor, data: { round, ...data } });

  if (contested.length === 0) {
    record({ contested: [], ruling: 'none', reason: 'no contested findings' });
    return { code: 0, out: `${summary}ruling: none\n`, err: '' };
  }
  let judge;
  try {
    judge = adapter ?? getAdapter(cfg.judge);
  } catch (e) {
    return fail(1, e.message);
  }
  const request = buildJudgeRequest(contested, plan);
  const reply = await judge.run({ ...request, cwd: root, timeout_s: cfg.judge.timeout_s ?? 600 });
  if (!reply?.ok) return fail(1, `adapter ${actor.adapter} failed: ${reply?.error ?? 'no reply'}`);
  let rulings;
  try {
    rulings = parseRulings(reply.json, contested.map((g) => g.key));
  } catch (e) {
    return fail(1, e.message);
  }
  for (const r of rulings) record({ contested: [r.key], ruling: r.ruling, reason: r.reason });
  return { code: 0, out: summary + rulings.map((r) => `ruling: ${r.ruling} ${r.key}\n`).join(''), err: '' };
}
