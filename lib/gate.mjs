// Stale-plan gate (roadmap section 3.7): a review is only valid for the plan hash it saw.
// The plan of record is the plan_sha of the latest `plan.created` or `plan.rebound` event.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planSha } from './plan-hash.mjs';
import { readEvents, append } from './ledger.mjs';

export const MIN_REASON_LENGTH = 10;
const ANCHORS = ['plan.created', 'plan.rebound'];
const GATE_ACTOR = Object.freeze({ role: 'gate', adapter: 'councilkit', model: null });
const REBIND_ACTOR = Object.freeze({ role: 'human', adapter: 'councilkit', model: null });

// Bad input (unreadable plan, short reason): the CLI maps it to exit 2.
export class GateInputError extends Error {}

export function files(slug, root) {
  const dir = join(root, '.councilkit', slug);
  return { plan: join(dir, 'plan.md'), ledger: join(dir, 'ledger.jsonl') };
}

export function readPlan(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new GateInputError(`cannot read plan ${file}: ${e.code ?? e.message}`);
  }
}

const currentSha = (file) => planSha(readPlan(file));

// The ledger as events, or the exit-3 result when the chain is broken.
export function load(file) {
  const state = readEvents(file);
  if (state.ok) return { events: state.events };
  return { broken: { code: 3, out: '', err: `councilkit: ${file}: line ${state.line}: ${state.reason}\n` } };
}

export const lastAnchor = (events) => events.findLastIndex((e) => ANCHORS.includes(e.type));

// Why the gate must block, or null. Only gate.passed events after the plan of record count:
// a rebind supersedes everything bound to the earlier hash.
function blockReason(events, got) {
  const i = lastAnchor(events);
  if (i < 0) return { expected: null, reason: 'no plan.created or plan.rebound in the ledger' };
  const expected = events[i].plan_sha;
  if (got !== expected) return { expected, reason: `plan changed since last review: expected ${expected} got ${got}` };
  for (const e of events.slice(i + 1)) {
    if (e.type !== 'gate.passed') continue;
    const bound = [e.plan_sha, e.data.plan_sha].find((s) => s !== undefined && s !== expected);
    if (bound) return { expected, reason: `gate.passed at seq ${e.seq} is bound to ${bound}, not ${expected}` };
  }
  // A judge that asked for a human blocks until a rebind supersedes this plan of record.
  const human = events.slice(i + 1).find((e) => e.type === 'judge.ruled' && e.data.ruling === 'needs-human');
  if (human) {
    const keys = Array.isArray(human.data.contested) ? human.data.contested.join(', ') : '';
    return { expected, reason: `judge needs a human on ${keys}: ${human.data.reason}` };
  }
  return { expected, reason: null };
}

// { code, out, err }: 0 the plan is the one reviewed, 2 blocked (one gate.blocked appended), 3 broken ledger.
export function gateReview(slug, { root = '.' } = {}) {
  const f = files(slug, root);
  const got = currentSha(f.plan);
  const { events, broken } = load(f.ledger);
  if (broken) return broken;
  const { expected, reason } = blockReason(events, got);
  if (reason) {
    append(f.ledger, { type: 'gate.blocked', plan_sha: got, actor: { ...GATE_ACTOR }, data: { gate: 'review', expected, got, reason } });
    return { code: 2, out: '', err: `councilkit: gate review blocked: ${reason}\n` };
  }
  const stale = events.filter((e) => e.type === 'review.submitted' && e.plan_sha !== expected).map((e) => e.seq);
  const note = stale.length
    ? `stale: ${stale.length} review${stale.length === 1 ? '' : 's'} bound to an earlier plan (seq ${stale.join(', ')})\n`
    : '';
  return { code: 0, out: `ok: plan ${got}\n${note}`, err: '' };
}

// Records a human decision that the current plan replaces the reviewed one.
// { code, out, err }: 0 with the written line on `out`, 3 broken ledger.
export function rebindPlan(slug, reason, { root = '.' } = {}) {
  if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH) {
    throw new GateInputError(`--reason is required (at least ${MIN_REASON_LENGTH} characters)`);
  }
  const f = files(slug, root);
  const got = currentSha(f.plan);
  const { events, broken } = load(f.ledger);
  if (broken) return broken;
  const i = lastAnchor(events);
  const data = { reason: reason.trim(), previous_plan_sha: i < 0 ? null : events[i].plan_sha };
  const line = append(f.ledger, { type: 'plan.rebound', plan_sha: got, actor: { ...REBIND_ACTOR }, data });
  return { code: 0, out: `${JSON.stringify(line)}\n`, err: '' };
}
