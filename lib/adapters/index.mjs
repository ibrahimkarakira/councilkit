// Adapter interface (roadmap section 3.8): every adapter is { name, run(request) }, where
// request = { role, prompt, schema, cwd, timeout_s } and run resolves to { ok, json, raw, exit }
// plus `error` when ok is false. Adapters never throw from run; they report failure in the result.
import { ADAPTERS } from '../config.mjs';
import { createReplayAdapter } from './replay.mjs';

const FACTORIES = { replay: createReplayAdapter };

// cfg is one reviewer or judge entry from councilkit.json.
export function getAdapter(cfg) {
  const name = cfg?.adapter;
  if (!ADAPTERS.includes(name)) throw new Error(`unknown adapter "${name}"; expected one of ${ADAPTERS.join(', ')}`);
  const factory = FACTORIES[name];
  if (!factory) throw new Error(`adapter "${name}" is not available yet; use "replay"`);
  return factory(cfg);
}
