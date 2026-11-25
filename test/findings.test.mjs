import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEVERITIES, contestKey, validateFinding, contested, uncontestedBlockers, uncontestedRest,
} from '../lib/findings.mjs';
import { DEFAULTS } from '../lib/config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = DEFAULTS.rules;

const f = (id, severity, extra = {}) => ({
  id, anchor: 'Acceptance', category: 'testability', severity, claim: `${severity} claim`, ...extra,
});
const review = (reviewer, findings, extra = {}) => ({ reviewer, findings, ...extra });
const KEY = 'Acceptance|testability';

// The five cases from the issue. `blockers` / `rest` list the keys with the reviewers that reported them.
const TABLE = [
  {
    name: 'both blocker: not contested',
    reviews: [review('a', [f('F1', 'blocker')]), review('b', [f('F1', 'blocker')])],
    contested: [], blockers: [[KEY, ['a', 'b']]], rest: [],
  },
  {
    name: 'blocker vs minor: contested',
    reviews: [review('a', [f('F1', 'blocker')]), review('b', [f('F1', 'minor')])],
    contested: [KEY], blockers: [], rest: [],
  },
  {
    name: 'blocker vs absent: not contested, single-reviewer blocker',
    reviews: [review('a', [f('F1', 'blocker')]), review('b', [])],
    contested: [], blockers: [[KEY, ['a']]], rest: [],
  },
  {
    name: 'explicit dispute: contested',
    reviews: [review('a', [f('F1', 'major')]), review('b', [], { disputes: ['F1'] })],
    contested: [KEY], blockers: [], rest: [],
  },
  {
    name: 'builder rebuttal: contested',
    reviews: [review('a', [f('F1', 'blocker')]), review('builder', [], { rebuttals: ['F1'] })],
    contested: [KEY], blockers: [], rest: [],
  },
  {
    name: 'two reviewers both use F1: reviewer/id contests only that reviewer\'s key',
    reviews: [
      review('a', [f('F1', 'blocker')]),
      review('b', [], { disputes: ['a/F1'] }),
      review('c', [f('F1', 'blocker', { anchor: 'Scope' })]),
    ],
    contested: [KEY], blockers: [['Scope|testability', ['c']]], rest: [],
  },
];

const summary = (groups) => groups.map((g) => [g.key, g.reviewers]);

for (const row of TABLE) {
  test(`table: ${row.name}`, () => {
    assert.deepEqual(contested(row.reviews, rules), row.contested);
    assert.deepEqual(summary(uncontestedBlockers(row.reviews, rules)), row.blockers);
    assert.deepEqual(summary(uncontestedRest(row.reviews, rules)), row.rest);
  });
}

test('contestKey is anchor|category', () => {
  assert.equal(contestKey(f('F1', 'nit')), KEY);
});

test('agreeing non-blockers go to the rest, minor and nit are the same side', () => {
  const reviews = [review('a', [f('F1', 'minor')]), review('b', [f('F2', 'nit')])];
  assert.deepEqual(contested(reviews, rules), []);
  assert.deepEqual(uncontestedBlockers(reviews, rules), []);
  const [rest] = uncontestedRest(reviews, rules);
  assert.deepEqual([rest.key, rest.reviewers, rest.findings.map((x) => x.id)], [KEY, ['a', 'b'], ['F1', 'F2']]);
});

test('blocker_severities moves the line: blocker vs major is uncontested when both block', () => {
  const reviews = [review('a', [f('F1', 'blocker')]), review('b', [f('F1', 'major')])];
  const wide = { ...rules, blocker_severities: ['blocker', 'major'] };
  assert.deepEqual(contested(reviews, rules), [KEY]);
  assert.deepEqual(contested(reviews, wide), []);
  assert.deepEqual(summary(uncontestedBlockers(reviews, wide)), [[KEY, ['a', 'b']]]);
});

test('a dispute may name a contest key, and a reviewer cannot dispute its own finding', () => {
  const byKey = [review('a', [f('F1', 'nit')]), review('b', [], { disputes: [KEY] })];
  assert.deepEqual(contested(byKey, rules), [KEY]);
  const self = [review('a', [f('F1', 'blocker')], { disputes: ['F1'] })];
  assert.deepEqual(contested(self, rules), []);
});

test('a dispute or rebuttal of an unknown id contests nothing', () => {
  const reviews = [review('a', [f('F1', 'blocker')]), review('b', [], { disputes: ['F9'], rebuttals: ['X|y'] })];
  assert.deepEqual(contested(reviews, rules), []);
});

test('a bare id held by two other reviewers is rejected; held by one it still resolves', () => {
  const twoF1 = [review('a', [f('F1', 'blocker')]), review('c', [f('F1', 'blocker', { anchor: 'Scope' })])];
  assert.throws(() => contested([...twoF1, review('b', [], { disputes: ['F1'] })], rules),
    { name: 'TypeError', message: 'reviews[2]: F1 matches findings from a, c; name one as reviewer/id' });
  assert.throws(() => contested([...twoF1, review('builder', [], { rebuttals: ['F1'] })], rules), TypeError);
  // a's own F1 does not count against a bare F1 in a's disputes.
  const own = [review('a', [f('F1', 'nit', { anchor: 'Scope' })], { disputes: ['F1'] }), review('c', [f('F1', 'blocker')])];
  assert.deepEqual(contested(own, rules), [KEY]);
});

test('only the disputed finding is contested; other keys keep their side', () => {
  const other = { anchor: 'Scope', category: 'size' };
  const reviews = [
    review('a', [f('F1', 'blocker'), f('F2', 'blocker', other)]),
    review('b', [f('F1', 'nit')]),
  ];
  assert.deepEqual(contested(reviews, rules), [KEY]);
  assert.deepEqual(summary(uncontestedBlockers(reviews, rules)), [['Scope|size', ['a']]]);
});

test('invalid findings are rejected with a path-style message', () => {
  assert.deepEqual(validateFinding(f('F1', 'critical')), [`severity must be one of ${SEVERITIES.join(', ')}`]);
  assert.deepEqual(validateFinding({ ...f('F1', 'nit'), anchor: 'A|B' }), ['anchor must be a non-empty string without |']);
  assert.deepEqual(validateFinding({ ...f('F1', 'nit'), extra: 1 }), ['extra is not a known key']);
  assert.deepEqual(validateFinding({ ...f('F1', 'nit'), disputes: 'F2' }), ['disputes must be an array of non-empty strings']);
  assert.throws(() => contested([review('a', [f('F1', 'bad')])], rules),
    { name: 'TypeError', message: 'reviews[0].findings[0].severity must be one of blocker, major, minor, nit' });
  assert.throws(() => contested([{ findings: [] }], rules), { message: 'reviews[0].reviewer must be a non-empty string' });
});

test('the schema matches the validator', () => {
  const schema = JSON.parse(readFileSync(join(root, 'schemas', 'finding.schema.json'), 'utf8'));
  assert.deepEqual(schema.properties.severity.enum, SEVERITIES);
  assert.deepEqual(schema.required, ['id', 'anchor', 'category', 'severity', 'claim']);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['anchor', 'category', 'claim', 'disputes', 'evidence', 'id', 'severity']);
  assert.equal(schema.additionalProperties, false);
});

// mulberry32: a tiny seeded PRNG so the property test is reproducible.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomReviews(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const anchors = ['Goal', 'Scope', 'Acceptance'];
  const categories = ['testability', 'risk'];
  const reviewers = ['a', 'b', 'c'].slice(0, 1 + Math.floor(rand() * 3));
  const reviews = reviewers.map((reviewer) => {
    const findings = Array.from({ length: Math.floor(rand() * 5) }, (_, i) => ({
      id: `F${i + 1}`, anchor: pick(anchors), category: pick(categories), severity: pick(SEVERITIES), claim: 'x',
    }));
    const disputes = rand() < 0.2 ? [`${pick(reviewers)}/F${1 + Math.floor(rand() * 4)}`] : [];
    return { reviewer, findings, disputes };
  });
  if (rand() < 0.2) reviews.push({ reviewer: 'builder', findings: [], rebuttals: [`${pick(anchors)}|${pick(categories)}`] });
  return reviews;
}

// Independent oracle for randomReviews output (qualified reviewer/id disputes, key rebuttals). Per key, each
// reviewer takes the blocking side if any of its findings there blocks; the key is contested when two
// reviewers take opposite sides, or a reviewer other than the finding's owner disputes or rebuts it.
function oracle(reviews) {
  const blocking = new Set(rules.blocker_severities);
  const keys = new Map();
  for (const { reviewer, findings } of reviews) {
    for (const fd of findings) {
      const k = contestKey(fd);
      if (!keys.has(k)) keys.set(k, { sides: new Map(), challenged: false });
      const sides = keys.get(k).sides;
      sides.set(reviewer, sides.get(reviewer) === true || blocking.has(fd.severity));
    }
  }
  for (const { reviewer, disputes = [], rebuttals = [] } of reviews) {
    for (const target of [...disputes, ...rebuttals]) {
      const [owner, id] = target.split('/');
      const hits = target.includes('|') ? [target]
        : reviews.filter((r) => r.reviewer === owner && owner !== reviewer)
          .flatMap((r) => r.findings.filter((fd) => fd.id === id).map(contestKey));
      for (const k of hits) {
        if (keys.has(k) && [...keys.get(k).sides.keys()].some((name) => name !== reviewer)) keys.get(k).challenged = true;
      }
    }
  }
  const out = { hot: [], blockers: [], rest: [] };
  for (const [k, { sides, challenged }] of keys) {
    const vals = [...sides.values()];
    if (challenged || (vals.includes(true) && vals.includes(false))) out.hot.push(k);
    else (vals.includes(true) ? out.blockers : out.rest).push(k);
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

test('property: over 200 seeded random review sets the buckets match an independent oracle and never overlap', () => {
  const rand = mulberry32(20261125);
  let seen = 0;
  for (let i = 0; i < 200; i += 1) {
    const reviews = randomReviews(rand);
    const want = oracle(reviews);
    assert.deepEqual(contested(reviews, rules), want.hot, `set ${i}: contested`);
    assert.deepEqual(uncontestedBlockers(reviews, rules).map((g) => g.key), want.blockers, `set ${i}: blockers`);
    assert.deepEqual(uncontestedRest(reviews, rules).map((g) => g.key), want.rest, `set ${i}: rest`);
    seen += want.hot.length;
    const hot = new Set(contested(reviews, rules));
    const blockers = uncontestedBlockers(reviews, rules).map((g) => g.key);
    const rest = uncontestedRest(reviews, rules).map((g) => g.key);
    for (const key of blockers) assert.ok(!hot.has(key), `set ${i}: ${key} is contested and an uncontested blocker`);
    for (const key of rest) assert.ok(!hot.has(key) && !blockers.includes(key), `set ${i}: ${key} is in two buckets`);
    const all = new Set(reviews.flatMap((r) => r.findings.map(contestKey)));
    assert.equal(hot.size + blockers.length + rest.length, all.size, `set ${i}: every reported key lands in exactly one bucket`);
  }
  assert.ok(seen > 0, 'the generator produced at least one contested key');
});

test('a dispute carried on a finding contests the target key, not the finding that carries it', () => {
  const reviews = [
    review('a', [f('F1', 'blocker')]),
    review('b', [f('F2', 'nit', { anchor: 'Scope', disputes: ['a/F1'] })]),
  ];
  assert.deepEqual(contested(reviews, rules), [KEY]);
  assert.deepEqual(uncontestedBlockers(reviews, rules), []);
  assert.deepEqual(uncontestedRest(reviews, rules).map((g) => g.key), ['Scope|testability']);
});

test('a finding cannot dispute its own reviewer\'s finding', () => {
  const reviews = [review('a', [f('F1', 'blocker'), f('F2', 'nit', { anchor: 'Scope', disputes: ['F1', KEY] })])];
  assert.deepEqual(contested(reviews, rules), []);
  assert.deepEqual(uncontestedBlockers(reviews, rules).map((g) => g.key), [KEY]);
});
