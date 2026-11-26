// The end-of-run decision (roadmap D18). approve only when the review gate is fresh (which covers
// needs-human rulings), the latest round has at least one review, no review errored, no blocker in
// that round is left unresolved, and the latest build for HEAD exited 0; otherwise changes.
// A blocker is resolved only by a judge.ruled "dismiss" for its contest key in the same round
// (the last ruling for a key wins); uncontested and upheld blockers stay on the fix list.
import { append } from './ledger.mjs';
import { roundGroups } from './judge.mjs';
import { loadConfig, ConfigError } from './config.mjs';
import { files, lastAnchor, checkReview, GateInputError } from './gate.mjs';
import { commitOf, buildReason } from './build.mjs';

const VERDICT_ACTOR = Object.freeze({ role: 'verdict', adapter: 'councilkit', model: null });

function rulesOf(root) {
  try {
    return loadConfig(root).rules;
  } catch (e) {
    if (e instanceof ConfigError) throw new GateInputError(e.message);
    throw e;
  }
}

// Reasons the latest round's reviews block approval; `round` is null when there are none.
function reviewReasons(events, sha, rules) {
  const reviews = events.filter((e) => e.type === 'review.submitted' && e.plan_sha === sha);
  const round = reviews.reduce((max, e) => (Number.isSafeInteger(e.data.round) && e.data.round > max ? e.data.round : max), 0);
  if (!round) return { round: null, reasons: ['no review.submitted since the plan of record'] };
  const latest = reviews.filter((e) => e.data.round === round);
  const reviewer = (e) => e.data.reviewer ?? e.actor?.adapter;
  const reasons = latest.filter((e) => e.data.verdict === 'error').map((e) => `review by ${reviewer(e)} in round ${round} is an error`);
  const ruling = new Map();
  for (const e of events) {
    if (e.type !== 'judge.ruled' || e.data.round !== round || !Array.isArray(e.data.contested)) continue;
    for (const key of e.data.contested) ruling.set(key, e.data.ruling);
  }
  for (const g of roundGroups(events, round, sha, rules)) {
    if (g.blocker && ruling.get(g.key) !== 'dismiss') reasons.push(`unresolved blocker ${g.key} (${g.reviewers.join(', ')})`);
  }
  return { round, reasons };
}

// { code, out, err }: 0 approve, 2 changes, 3 broken ledger. Appends one verdict.issued either way.
export function issueVerdict(slug, { root = '.' } = {}) {
  const f = files(slug, root);
  const { broken, got, events, reason } = checkReview(slug, { root });
  if (broken) return broken;
  const since = events.slice(lastAnchor(events) + 1);
  const head = commitOf('HEAD', root);
  const { round, reasons } = reviewReasons(since, got, rulesOf(root));
  const why = [reason, ...reasons, buildReason(events, head)].filter(Boolean);
  const verdict = why.length ? 'changes' : 'approve';
  append(f.ledger, { type: 'verdict.issued', plan_sha: got, actor: { ...VERDICT_ACTOR }, data: { verdict, round, head, reasons: why } });
  return { code: verdict === 'approve' ? 0 : 2, out: `verdict: ${verdict}\n${why.map((w) => `- ${w}\n`).join('')}`, err: '' };
}
