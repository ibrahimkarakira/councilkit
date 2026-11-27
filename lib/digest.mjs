// Ledger digest and CI verification (roadmap D23, docs/ci.md). The chain proves order, not length:
// a ledger with its last lines cut off still verifies. The digest line, pasted into the PR body,
// anchors the head so `verify --expect-head` / `verify --ci --heads` catch that truncation.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from './ledger.mjs';
import { planSha } from './plan-hash.mjs';

export const HEAD_RE = /^sha256:[0-9a-f]{64}$/;
const DIGEST_RE = /councilkit-ledger: ([A-Za-z0-9][A-Za-z0-9._-]*) seq=\d+ head=(sha256:[0-9a-f]{64}) plan=sha256:[0-9a-f]{64}/g;

export class HeadsError extends Error {}

const result = (code, out = '', err = '') => ({ code, out, err });
const digestLine = (slug, last) => `councilkit-ledger: ${slug} seq=${last.seq} head=${last.hash} plan=${last.plan_sha}`;

// slug -> head for every digest line anywhere in `text` (a PR body: prose, backticks, CRLF are fine).
export function parseHeads(text) {
  const heads = new Map();
  for (const [, slug, head] of text.matchAll(DIGEST_RE)) {
    if (heads.has(slug) && heads.get(slug) !== head) throw new HeadsError(`two different heads for ${slug}`);
    heads.set(slug, head);
  }
  return heads;
}

// `digest --slug s`: 0 printed, 2 no ledger or an empty one, 3 chain broken.
export function runDigest(slug, dir = '.councilkit') {
  const file = join(dir, slug, 'ledger.jsonl');
  if (!existsSync(file)) return result(2, '', `councilkit: no ledger at ${file}\n`);
  const state = readEvents(file);
  if (!state.ok) return result(3, '', `councilkit: ${file}: line ${state.line}: ${state.reason}\n`);
  if (!state.events.length) return result(2, '', `councilkit: ${file} is empty\n`);
  return result(0, `${digestLine(slug, state.events.at(-1))}\n`);
}

// One ledger: the chain, its last plan_sha against plan.md as checked out, and the head when
// `expectHead` is a string. Returns null when every check passes, else the reason.
function checkLedger(dir, slug, expectHead) {
  const state = readEvents(join(dir, slug, 'ledger.jsonl'));
  if (!state.ok) return { reason: `line ${state.line}: ${state.reason}` };
  const last = state.events.at(-1);
  if (!last) return { reason: 'the ledger is empty' };
  let plan;
  try {
    plan = planSha(readFileSync(join(dir, slug, 'plan.md'), 'utf8'));
  } catch (e) {
    return { reason: `cannot read plan.md: ${e.code ?? e.message}` };
  }
  if (plan !== last.plan_sha) return { reason: `plan.md is ${plan}, the ledger's last plan_sha is ${last.plan_sha}` };
  if (expectHead !== undefined && expectHead !== last.hash) {
    return { reason: `head ${last.hash} (seq ${last.seq}) does not match the expected head ${expectHead}` };
  }
  return { last };
}

const slugsUnder = (dir) => readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'ledger.jsonl')))
  .map((e) => e.name).sort();

// `verify --ci`: every ledger under `dir`; with `headsText`, each needs a matching digest line there.
// `verify --slug`: one ledger, head checked against `expectHead` when given.
// 0 all pass, 2 bad input (missing dir or ledger, conflicting heads), 3 any check failed.
export function runVerify({ dir = '.councilkit', slug, expectHead, headsText }) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return result(2, '', `councilkit: no directory ${dir}\n`);
  let heads = null;
  try {
    if (headsText !== undefined) heads = parseHeads(headsText);
  } catch (e) {
    if (!(e instanceof HeadsError)) throw e;
    return result(2, '', `councilkit: --heads: ${e.message}\n`);
  }
  const slugs = slug === undefined ? slugsUnder(dir) : [slug];
  if (slug !== undefined && !existsSync(join(dir, slug, 'ledger.jsonl'))) {
    return result(2, '', `councilkit: no ledger at ${join(dir, slug, 'ledger.jsonl')}\n`);
  }
  let out = '';
  let err = '';
  for (const s of slugs) {
    const expected = heads ? heads.get(s) : expectHead;
    const r = heads && expected === undefined
      ? { reason: 'no councilkit-ledger line for this slug in --heads' }
      : checkLedger(dir, s, expected);
    if (r.reason) err += `councilkit: ${s}: ${r.reason}\n`;
    else out += `ok: ${s} seq=${r.last.seq} head=${r.last.hash}\n`;
  }
  // A deleted ledger is the extreme tail truncation: an anchored slug with nothing on disk fails.
  for (const s of heads ? [...heads.keys()].sort() : []) {
    if (!slugs.includes(s)) err += `councilkit: ${s}: a digest line in --heads names a ledger that does not exist\n`;
  }
  if (slug === undefined && !err) out += `ok: ${slugs.length} ledger${slugs.length === 1 ? '' : 's'} under ${dir}\n`;
  return result(err ? 3 : 0, out, err);
}
