// Records one lens agent's output as review.submitted (roadmap D16). The output is a JSON array of
// findings (schemas/finding.schema.json), optionally inside one ```json fence. Anything else is still
// recorded, as verdict "error" with no findings, so a bad review is evidence and never silently dropped.
import { planSha } from './plan-hash.mjs';
import { append } from './ledger.mjs';
import { validateFinding } from './findings.mjs';
import { loadConfig, ConfigError } from './config.mjs';
import { files, readPlan, load, GateInputError } from './gate.mjs';

const ACTOR = Object.freeze({ role: 'reviewer', adapter: 'claude-code', model: null });
const FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```$/;

// The findings array, or a thrown Error naming the first problem.
export function parseFindings(text) {
  const body = text.trim();
  let value;
  try {
    value = JSON.parse(body.match(FENCE_RE)?.[1] ?? body);
  } catch (e) {
    throw new Error(`lens output is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(value)) throw new Error('lens output must be a JSON array of findings');
  const ids = new Set();
  value.forEach((f, i) => {
    const [first] = validateFinding(f);
    if (first) throw new Error(`findings[${i}].${first}`);
    if (ids.has(f.id)) throw new Error(`findings[${i}].id ${f.id} is duplicated`);
    ids.add(f.id);
  });
  return value;
}

// { code, out, err }: 0 recorded, 1 recorded as verdict "error", 2 bad input, 3 broken ledger.
export function ingestReview(slug, lens, round, text, { root = '.', config } = {}) {
  const f = files(slug, root);
  const sha = planSha(readPlan(f.plan));
  let cfg = config;
  try {
    cfg ??= loadConfig(root);
  } catch (e) {
    if (e instanceof ConfigError) throw new GateInputError(e.message);
    throw e;
  }
  const { broken } = load(f.ledger);
  if (broken) return broken;
  const data = { reviewer: `lens-${lens}`, lens, round };
  let findings;
  try {
    findings = parseFindings(text);
  } catch (e) {
    append(f.ledger, { type: 'review.submitted', plan_sha: sha, actor: { ...ACTOR }, data: { ...data, verdict: 'error', findings: [], error: e.message } });
    return { code: 1, out: '', err: `councilkit: review ingest: lens-${lens}: ${e.message}; recorded as verdict "error"\n` };
  }
  const blocking = new Set(cfg.rules.blocker_severities);
  const verdict = findings.some((x) => blocking.has(x.severity)) ? 'changes' : 'approve';
  const line = append(f.ledger, { type: 'review.submitted', plan_sha: sha, actor: { ...ACTOR }, data: { ...data, verdict, findings } });
  return { code: 0, out: `${JSON.stringify(line)}\n`, err: '' };
}
