// councilkit.json loader: defaults, per-section merge, hand-written validator with path-style errors.
// schemas/config.schema.json mirrors the structure; the cross-field rules (ascending tiers, unique ids,
// null only on the last tier) live here only, because JSON Schema cannot express them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FILE = 'councilkit.json';
export const ADAPTERS = ['codex', 'command', 'replay'];

export const DEFAULTS = Object.freeze({
  version: 1,
  dir: '.councilkit',
  reviewers: [{ id: 'codex', adapter: 'codex', model: null, sandbox: 'read-only', timeout_s: 600 }],
  judge: { adapter: 'codex', model: null, timeout_s: 600 },
  panel: {
    tiers: [
      { max_changed_lines: 50, lenses: ['correctness', 'acceptance'] },
      { max_changed_lines: 400, lenses: ['correctness', 'acceptance', 'tests'] },
      { max_changed_lines: null, lenses: ['correctness', 'acceptance', 'tests', 'security', 'performance'] },
    ],
  },
  rules: { max_fix_rounds: 3, blocker_severities: ['blocker'], block_on_stale_plan: true },
});

const ADAPTER_KEYS = ['adapter', 'model', 'sandbox', 'timeout_s', 'command'];

export class ConfigError extends Error {
  constructor(file, errors) {
    super(`${file}: ${errors.join('; ')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const isPosInt = (v) => Number.isInteger(v) && v >= 1;
const isTextList = (v) => Array.isArray(v) && v.length > 0 && v.every(isText);

function unknownKeys(obj, allowed, path, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${path}${key} is not a known key`);
  }
}

function checkAdapter(a, path, errors, extraKeys = []) {
  if (!isObject(a)) return errors.push(`${path} must be an object`);
  unknownKeys(a, [...extraKeys, ...ADAPTER_KEYS], `${path}.`, errors);
  if (!ADAPTERS.includes(a.adapter)) errors.push(`${path}.adapter must be one of ${ADAPTERS.join(', ')}`);
  if ('model' in a && a.model !== null && typeof a.model !== 'string') errors.push(`${path}.model must be a string or null`);
  if ('sandbox' in a && !isText(a.sandbox)) errors.push(`${path}.sandbox must be a non-empty string`);
  if ('timeout_s' in a && !isPosInt(a.timeout_s)) errors.push(`${path}.timeout_s must be an integer >= 1`);
  if ((a.adapter === 'command' || 'command' in a) && !isTextList(a.command)) {
    errors.push(`${path}.command must be a non-empty array of non-empty strings`);
  }
}

function checkReviewers(list, errors) {
  if (!Array.isArray(list) || list.length === 0) return errors.push('reviewers must be a non-empty array');
  const seen = new Map();
  list.forEach((r, i) => {
    const path = `reviewers[${i}]`;
    checkAdapter(r, path, errors, ['id']);
    if (!isObject(r)) return;
    if (!isText(r.id)) errors.push(`${path}.id must be a non-empty string`);
    else if (seen.has(r.id)) errors.push(`${path}.id duplicates reviewers[${seen.get(r.id)}].id`);
    else seen.set(r.id, i);
  });
}

function checkPanel(panel, errors) {
  if (!isObject(panel)) return errors.push('panel must be an object');
  unknownKeys(panel, ['tiers'], 'panel.', errors);
  const { tiers } = panel;
  if (!Array.isArray(tiers) || tiers.length === 0) return errors.push('panel.tiers must be a non-empty array');
  let previous = 0;
  tiers.forEach((tier, i) => {
    const path = `panel.tiers[${i}]`;
    if (!isObject(tier)) return errors.push(`${path} must be an object`);
    unknownKeys(tier, ['max_changed_lines', 'lenses'], `${path}.`, errors);
    const max = tier.max_changed_lines;
    if (max === null) {
      if (i !== tiers.length - 1) errors.push(`${path}.max_changed_lines may be null only on the last tier`);
    } else if (!isPosInt(max)) {
      errors.push(`${path}.max_changed_lines must be an integer >= 1 or null`);
    } else if (max <= previous) {
      errors.push(`${path}.max_changed_lines must be greater than the previous tier`);
    } else {
      previous = max;
    }
    if (!isTextList(tier.lenses)) errors.push(`${path}.lenses must be a non-empty array of non-empty strings`);
  });
}

function checkRules(rules, errors) {
  if (!isObject(rules)) return errors.push('rules must be an object');
  unknownKeys(rules, Object.keys(DEFAULTS.rules), 'rules.', errors);
  if (!isPosInt(rules.max_fix_rounds)) errors.push('rules.max_fix_rounds must be an integer >= 1');
  if (!isTextList(rules.blocker_severities)) errors.push('rules.blocker_severities must be a non-empty array of non-empty strings');
  if (typeof rules.block_on_stale_plan !== 'boolean') errors.push('rules.block_on_stale_plan must be a boolean');
}

// Returns every problem as a path-style message; empty array = valid.
export function validateConfig(config) {
  if (!isObject(config)) return ['the config must be a JSON object'];
  const errors = [];
  unknownKeys(config, Object.keys(DEFAULTS), '', errors);
  if (config.version !== 1) errors.push('version must be 1');
  if (!isText(config.dir)) errors.push('dir must be a non-empty string');
  checkReviewers(config.reviewers, errors);
  checkAdapter(config.judge, 'judge', errors);
  checkPanel(config.panel, errors);
  checkRules(config.rules, errors);
  return errors;
}

// Top-level keys replace the defaults; judge, panel and rules merge one level deep.
function merge(user) {
  const out = structuredClone({ ...DEFAULTS, ...user });
  for (const key of ['judge', 'panel', 'rules']) {
    if (isObject(user[key])) out[key] = structuredClone({ ...DEFAULTS[key], ...user[key] });
  }
  return out;
}

// Reads <dir>/councilkit.json. A missing file gives the defaults; anything invalid throws ConfigError.
export function loadConfig(dir) {
  const file = join(dir, FILE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(DEFAULTS);
    throw err;
  }
  let user;
  try {
    user = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new ConfigError(file, [`invalid JSON: ${err.message}`]);
  }
  if (!isObject(user)) throw new ConfigError(file, ['the config must be a JSON object']);
  const config = merge(user);
  const errors = validateConfig(config);
  if (errors.length) throw new ConfigError(file, errors);
  return config;
}
