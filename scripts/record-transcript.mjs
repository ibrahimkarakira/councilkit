#!/usr/bin/env node
// Records one adapter call as a replay transcript: runs the request through a real adapter and writes
// <out>/<key>.json = { request, response } for lib/adapters/replay.mjs.
//   node scripts/record-transcript.mjs --adapter <name> --request <request.json> [--out <dir>]
// Redaction pass: the fixture is refused (nothing written) if its text holds an absolute home path
// or an e-mail address, because transcripts are committed to a public repo.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getAdapter } from '../lib/adapters/index.mjs';
import { TRANSCRIPT_DIR, keyedRequest, requestKey } from '../lib/adapters/replay.mjs';

// Patterns run on the JSON text, where a Windows backslash is written as `\\`.
const PRIVATE = [
  ['a Windows home path', /[A-Za-z]:(\\\\|\/)Users(\\\\|\/)/i],
  ['a Unix home path', /\/(home|Users)\//],
  ['an e-mail address', /[\w.+-]+@[\w-]+(\.[\w-]+)+/],
];

export function privateMatches(text) {
  return PRIVATE.filter(([, re]) => re.test(text)).map(([label]) => label);
}

export async function record(adapter, request, outDir) {
  const response = await adapter.run(request);
  const fixture = { request: keyedRequest(request), response };
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  const found = privateMatches(text);
  if (found.length) throw new Error(`refusing to write transcript: it contains ${found.join(', ')}; redact the request or response`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${requestKey(request)}.json`);
  writeFileSync(file, text);
  return file;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { adapter: { type: 'string' }, request: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  if (!values.adapter || !values.request) {
    console.error('usage: record-transcript --adapter <name> --request <request.json> [--out <dir>]');
    return 2;
  }
  const request = JSON.parse(readFileSync(values.request, 'utf8'));
  const file = await record(getAdapter({ adapter: values.adapter }), request, values.out ?? TRANSCRIPT_DIR);
  console.log(file);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`record-transcript: ${err.message}`);
    process.exitCode = 1;
  });
}
