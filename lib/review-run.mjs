// Cross-model plan review (roadmap D12): check the review gate, ask every reviewer in councilkit.json
// about the plan in parallel, and record one review.submitted per reviewer, bound to the plan hash.
// A reviewer whose adapter fails or whose reply is not a valid findings object is still recorded, as
// verdict "error" with no findings, so a bad review is evidence and never silently dropped.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalisePlan } from './plan-hash.mjs';
import { append } from './ledger.mjs';
import { SEVERITIES } from './findings.mjs';
import { loadConfig, ConfigError } from './config.mjs';
import { getAdapter } from './adapters/index.mjs';
import { files, readPlan, load, lastAnchor, checkReview, GateInputError } from './gate.mjs';
import { checkFindings } from './review-ingest.mjs';
import { roundGroups } from './judge.mjs';

export const TARGETS = ['plan'];
export const PLAN_REVIEW_SCHEMA = Object.freeze({
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'anchor', 'category', 'severity', 'claim'],
        properties: {
          id: { type: 'string' }, anchor: { type: 'string' }, category: { type: 'string' },
          severity: { enum: SEVERITIES }, claim: { type: 'string' }, evidence: { type: 'string' },
        },
      },
    },
  },
});
const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'plan-review.md');

// The plan travels inside one JSON block, with backticks escaped so plan text cannot close the fence.
// The reviewer id is in the prompt so two reviewers on the same adapter get distinct requests.
export function planReviewRequest(id, plan, template = readFileSync(PROMPT_FILE, 'utf8')) {
  const json = JSON.stringify({ reviewer: id, plan: normalisePlan(plan) }, null, 2).replace(/`/g, '\\u0060');
  return { role: 'reviewer', prompt: `${template.trimEnd()}\n\n\`\`\`json\n${json}\n\`\`\`\n`, schema: PLAN_REVIEW_SCHEMA };
}

// "1 blocker, 2 minor" or "0 findings".
export const counts = (findings) => {
  const by = Object.groupBy(findings, (f) => f.severity);
  return Object.entries(by).map(([s, list]) => `${list.length} ${s}`).join(', ') || '0 findings';
};

async function ask(reviewer, request, root, adapterFor) {
  try {
    return await adapterFor(reviewer).run({ ...request, cwd: root, timeout_s: reviewer.timeout_s ?? 600 });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// { findings } or { error }.
function readReply(reply) {
  if (!reply?.ok) return { error: reply?.error ?? 'no reply' };
  if (!Array.isArray(reply.json?.findings)) return { error: 'reply must be a JSON object with a findings array' };
  try {
    return { findings: checkFindings(reply.json.findings) };
  } catch (e) {
    return { error: e.message };
  }
}

// { code, out, err }: 0 recorded, 1 recorded with at least one verdict "error", 2 blocked gate or bad
// input (no adapter called), 3 broken ledger. `round` defaults to one past the highest round recorded
// since the plan of record. `config` and `adapterFor` are injectable for tests.
export async function runReview(slug, { target = 'plan', round, root = '.', config, adapterFor = getAdapter } = {}) {
  if (!TARGETS.includes(target)) throw new GateInputError(`--target must be one of ${TARGETS.join(', ')}`);
  const f = files(slug, root);
  const plan = readPlan(f.plan);
  const { broken, events, expected: sha, reason } = checkReview(slug, { root });
  if (broken) return broken;
  if (reason) return { code: 2, out: '', err: `councilkit: review run blocked: ${reason}\n` };
  let cfg = config;
  try {
    cfg ??= loadConfig(root);
  } catch (e) {
    if (e instanceof ConfigError) throw new GateInputError(e.message);
    throw e;
  }
  const since = events.slice(lastAnchor(events) + 1);
  const n = round ?? 1 + Math.max(0, ...since.filter((e) => e.type === 'review.submitted').map((e) => e.data.round).filter(Number.isInteger));

  const replies = await Promise.all(cfg.reviewers.map((r) => ask(r, planReviewRequest(r.id, plan), root, adapterFor)));
  const blocking = new Set(cfg.rules.blocker_severities);
  const lines = [`round ${n}`];
  let errors = 0;
  cfg.reviewers.forEach((r, i) => {
    const { findings, error } = readReply(replies[i]);
    const verdict = error ? 'error' : findings.some((x) => blocking.has(x.severity)) ? 'changes' : 'approve';
    const data = { reviewer: r.id, target, round: n, verdict, findings: findings ?? [], ...(error ? { error } : {}) };
    append(f.ledger, { type: 'review.submitted', plan_sha: sha, actor: { role: 'reviewer', adapter: r.adapter, model: r.model ?? null }, data });
    if (error) errors += 1;
    lines.push(error ? `${r.id}: error (${error})` : `${r.id}: ${verdict} (${counts(findings)})`);
  });

  const after = load(f.ledger);
  if (after.broken) return after.broken;
  const groups = roundGroups(after.events.slice(lastAnchor(after.events) + 1), n, sha, cfg.rules);
  const keys = groups.filter((g) => g.contested).map((g) => g.key);
  lines.push(`contested: ${keys.length} of ${groups.length}${keys.length ? ` (${keys.join(', ')})` : ''}`);
  return { code: errors ? 1 : 0, out: `${lines.join('\n')}\n`, err: '' };
}
