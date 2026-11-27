// Fix-round cap (roadmap D22): review and fix loops must stop. A round's number is the highest of
// the round.opened and review.submitted rounds since the plan of record, so a rebind starts again at 1.
// Once round rules.max_fix_rounds (or a later one) still has an unresolved blocker, `review run` and
// `gate merge` block with reason "max_fix_rounds" until a human rebinds the plan or stops.
import { roundGroups } from './judge.mjs';
import { loadConfig, ConfigError } from './config.mjs';
import { GateInputError } from './gate.mjs';

export const MAX_FIX_ROUNDS = 'max_fix_rounds';
const ROUND_EVENTS = ['round.opened', 'review.submitted'];

const roundOf = (e) => (ROUND_EVENTS.includes(e.type) && Number.isSafeInteger(e.data?.round) && e.data.round > 0 ? e.data.round : 0);

// `since` = the events after the plan of record. 0 when no round has been opened or reviewed.
export const latestRound = (since) => since.reduce((max, e) => Math.max(max, roundOf(e)), 0);

// The rules from councilkit.json, with a bad config as bad input (exit 2).
export function rulesOf(root) {
  try {
    return loadConfig(root).rules;
  } catch (e) {
    if (e instanceof ConfigError) throw new GateInputError(e.message);
    throw e;
  }
}

// Contest groups of `round` with a blocker that no judge.ruled "dismiss" of that round resolved
// (the last ruling for a key wins); uncontested and upheld blockers stay unresolved.
export function unresolvedBlockers(since, round, sha, rules) {
  const ruling = new Map();
  for (const e of since) {
    if (e.type !== 'judge.ruled' || e.data.round !== round || !Array.isArray(e.data.contested)) continue;
    for (const key of e.data.contested) ruling.set(key, e.data.ruling);
  }
  return roundGroups(since, round, sha, rules).filter((g) => g.blocker && ruling.get(g.key) !== 'dismiss');
}

// null, or the cap that was hit: { data, message }. `data` goes into gate.blocked as is.
export function roundCap(since, sha, rules, slug) {
  const round = latestRound(since);
  const max = rules.max_fix_rounds;
  if (round < max) return null;
  const blockers = unresolvedBlockers(since, round, sha, rules).map((g) => g.key);
  if (!blockers.length) return null;
  const message = `${MAX_FIX_ROUNDS}: round ${round} of ${max} left ${blockers.length} unresolved blocker${blockers.length === 1 ? '' : 's'} (${blockers.join(', ')}).`
    + ` A human decides now: revise the plan and run councilkit plan rebind --slug ${slug} --reason '<why>' to start a new round count, or stop.`;
  return { data: { reason: MAX_FIX_ROUNDS, round, max_fix_rounds: max, blockers }, message };
}
