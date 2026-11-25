// Replay adapter: answers from recorded transcripts so tests never call a model (roadmap section 3.8).
// A transcript lives at <cwd>/fixtures/transcripts/<key>.json as { request, response }, where
// key = SHA-256 hex of canonical({ role, prompt, schema }). cwd and timeout_s are left out of the key
// on purpose: they differ between machines and runs, and would make every fixture miss elsewhere.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../ledger.mjs';

export const TRANSCRIPT_DIR = join('fixtures', 'transcripts');

export const keyedRequest = ({ role, prompt, schema }) => ({ role, prompt, schema: schema ?? null });

export function requestKey(request) {
  return createHash('sha256').update(canonical(keyedRequest(request)), 'utf8').digest('hex');
}

const fail = (error) => ({ ok: false, json: null, raw: '', exit: null, error });

export function createReplayAdapter() {
  return {
    name: 'replay',
    async run(request) {
      let key;
      try {
        key = requestKey(request);
      } catch (err) {
        return fail(`replay cannot key this request: ${err.message}`);
      }
      const file = join(request.cwd ?? process.cwd(), TRANSCRIPT_DIR, `${key}.json`);
      let fixture;
      try {
        fixture = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return fail(`no transcript for sha256:${key}`);
        return fail(`transcript sha256:${key} is unreadable: ${err.message}`);
      }
      let recordedKey = null;
      try {
        recordedKey = requestKey(fixture?.request ?? {});
      } catch { /* unkeyable request in the file: treated as a mismatch below */ }
      if (recordedKey !== key || typeof fixture.response?.ok !== 'boolean') {
        return fail(`transcript sha256:${key} does not match its request`);
      }
      return fixture.response;
    },
  };
}
