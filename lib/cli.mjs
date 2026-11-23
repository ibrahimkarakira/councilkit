// councilkit command line. Returns the process exit code: 0 ok, 1 error or bad usage.
import { readFileSync } from 'node:fs';
import { planSha } from './plan-hash.mjs';

const USAGE = 'usage: councilkit plan hash <file>';

export function main(argv, out = process.stdout, err = process.stderr) {
  const [group, command, file, ...rest] = argv;
  if (group !== 'plan' || command !== 'hash' || !file || rest.length) {
    err.write(`${USAGE}\n`);
    return 1;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    err.write(`councilkit: cannot read ${file}: ${e.code ?? e.message}\n`);
    return 1;
  }
  out.write(`${planSha(text)}\n`);
  return 0;
}
