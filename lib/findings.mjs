// Contest detection: pure functions over reviewer outputs, so the judge only ever sees disagreements.
// A review is { reviewer, findings: Finding[], disputes?: string[], rebuttals?: string[] }; the builder's
// rebuttals arrive as one more review (usually with no findings). A dispute or rebuttal names a contest key,
// a qualified finding id `reviewer/id`, or a bare id. Ids are unique only within one reviewer, so a bare id
// that matches findings from more than one other reviewer is a TypeError. Findings are grouped by contest key = anchor|category (exact match, roadmap 3.7).
// A key is contested when (1) two reviewers put it on opposite sides of rules.blocker_severities, or
// (2) another reviewer disputes it, or (3) the builder rebuts it. schemas/finding.schema.json mirrors
// validateFinding; this file is authoritative.

export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];
const KEYS = ['id', 'anchor', 'category', 'severity', 'claim', 'evidence', 'disputes'];

const isText = (v) => typeof v === 'string' && v.length > 0;
const isKeyPart = (v) => isText(v) && !v.includes('|');
const isTextArray = (v) => Array.isArray(v) && v.every(isText);

export const contestKey = (f) => `${f.anchor}|${f.category}`;

// Returns every problem as a message; empty array = valid.
export function validateFinding(f) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return ['must be an object'];
  const errors = Object.keys(f).filter((k) => !KEYS.includes(k)).map((k) => `${k} is not a known key`);
  for (const k of ['id', 'claim']) if (!isText(f[k])) errors.push(`${k} must be a non-empty string`);
  for (const k of ['anchor', 'category']) if (!isKeyPart(f[k])) errors.push(`${k} must be a non-empty string without |`);
  if (!SEVERITIES.includes(f.severity)) errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  if ('evidence' in f && typeof f.evidence !== 'string') errors.push('evidence must be a string');
  if ('disputes' in f && !isTextArray(f.disputes)) errors.push('disputes must be an array of non-empty strings');
  return errors;
}

function check(reviews) {
  if (!Array.isArray(reviews)) throw new TypeError('reviews must be an array');
  reviews.forEach((r, i) => {
    const at = `reviews[${i}]`;
    if (!isText(r?.reviewer)) throw new TypeError(`${at}.reviewer must be a non-empty string`);
    if (!Array.isArray(r.findings)) throw new TypeError(`${at}.findings must be an array`);
    for (const k of ['disputes', 'rebuttals']) {
      if (k in r && !isTextArray(r[k])) throw new TypeError(`${at}.${k} must be an array of non-empty strings`);
    }
    r.findings.forEach((f, j) => {
      const [first] = validateFinding(f);
      if (first) throw new TypeError(`${at}.findings[${j}].${first}`);
    });
  });
}

// The groups a dispute or rebuttal from reviewer `by` targets. Ids are unique only within one reviewer,
// so a bare id that matches findings from two or more other reviewers is rejected: write reviewer/id.
function resolve(target, by, groups, at) {
  if (target.includes('|')) return groups.has(target) ? [groups.get(target)] : [];
  const hits = new Set();
  const owners = new Set();
  for (const g of groups.values()) {
    for (const f of g.findings) {
      if (f.reviewer === by) continue;
      if (f.id === target) owners.add(f.reviewer);
      if (f.id === target || `${f.reviewer}/${f.id}` === target) hits.add(g);
    }
  }
  if (owners.size > 1) {
    throw new TypeError(`${at}: ${target} matches findings from ${[...owners].join(', ')}; name one as reviewer/id`);
  }
  return hits;
}

// One pass over the reviews: per key, the findings, the reviewers, which sides they took, and whether
// anyone else challenged it.
function classify(reviews, rules) {
  check(reviews);
  const blocking = new Set(rules.blocker_severities);
  const groups = new Map();
  for (const { reviewer, findings } of reviews) {
    for (const f of findings) {
      const key = contestKey(f);
      if (!groups.has(key)) groups.set(key, { key, reviewers: [], findings: [], sides: new Map(), challenged: false });
      const g = groups.get(key);
      if (!g.reviewers.includes(reviewer)) g.reviewers.push(reviewer);
      g.findings.push({ ...f, reviewer });
      const side = blocking.has(f.severity);
      g.sides.set(reviewer, (g.sides.get(reviewer) ?? side) || side);
    }
  }
  reviews.forEach((r, i) => {
    for (const target of [...(r.disputes ?? []), ...(r.rebuttals ?? []), ...r.findings.flatMap((f) => f.disputes ?? [])]) {
      for (const g of resolve(target, r.reviewer, groups, `reviews[${i}]`)) {
        if (g.reviewers.some((name) => name !== r.reviewer)) g.challenged = true;
      }
    }
  });
  return [...groups.values()].map((g) => {
    const sides = [...g.sides.values()];
    const split = sides.includes(true) && sides.includes(false);
    return { key: g.key, reviewers: g.reviewers, findings: g.findings, contested: split || g.challenged, blocker: sides.includes(true) };
  }).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const strip = ({ key, reviewers, findings }) => ({ key, reviewers, findings });

// Every contest key as { key, reviewers, findings, contested, blocker }, sorted by key.
export const contestGroups = classify;

// Sorted contest keys the judge must rule on.
export const contested = (reviews, rules) => classify(reviews, rules).filter((g) => g.contested).map((g) => g.key);

// Keys no one disputes where at least one reviewer reported a blocking severity: straight to the fix list.
// reviewers.length === 1 marks a single-reviewer blocker.
export const uncontestedBlockers = (reviews, rules) =>
  classify(reviews, rules).filter((g) => !g.contested && g.blocker).map(strip);

// Undisputed, non-blocking keys: logged only.
export const uncontestedRest = (reviews, rules) =>
  classify(reviews, rules).filter((g) => !g.contested && !g.blocker).map(strip);
