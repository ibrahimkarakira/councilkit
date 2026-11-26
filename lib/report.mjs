// Human-readable report of one ledger (roadmap D18): one row per event, then the chain head, the
// verify result and the latest verdict. Reads the ledger only; writes nothing.
import { existsSync } from 'node:fs';
import { SEVERITIES } from './findings.mjs';
import { files, load, GateInputError } from './gate.mjs';

const COLUMNS = ['seq', 'event', 'round', 'actor', 'verdict', 'findings', 'contested', 'rulings', 'plan'];

function findingCounts(findings) {
  if (!Array.isArray(findings)) return '';
  const counts = SEVERITIES.map((s) => [s, findings.filter((f) => f?.severity === s).length]).filter(([, n]) => n);
  return counts.length ? counts.map(([s, n]) => `${n} ${s}`).join(', ') : '0';
}

function verdictOf({ type, data }) {
  if (type === 'review.submitted' || type === 'verdict.issued') return String(data.verdict ?? '');
  if (type === 'build.recorded') return data.timed_out ? 'timed out' : `exit ${data.exit}`;
  if (type === 'gate.passed' || type === 'gate.blocked') return `${data.gate ?? ''} ${type.slice(5)}`.trim();
  return '';
}

function row(e) {
  const judged = e.type === 'judge.ruled';
  const contested = judged && Array.isArray(e.data.contested) ? e.data.contested : null;
  const { role, adapter, model } = e.actor ?? {};
  return [
    String(e.seq), e.type, e.data.round === undefined ? '' : String(e.data.round),
    [role, adapter, model].filter((x) => x !== null && x !== undefined).join('/'),
    verdictOf(e), e.type === 'review.submitted' ? findingCounts(e.data.findings) : '',
    contested ? String(contested.length) : '',
    judged ? [e.data.ruling, ...(contested ?? [])].join(' ') : '',
    e.plan_sha.slice(7, 19),
  ];
}

const mdCell = (s) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

function table(raw, md) {
  const rows = raw.map((r) => r.map((c) => c.replace(/\s+/g, ' ')));
  if (md) {
    const line = (cells) => `| ${cells.map(mdCell).join(' | ')} |`;
    return [line(COLUMNS), `|${COLUMNS.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n');
  }
  const widths = COLUMNS.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  return [COLUMNS, ...rows].map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

// { code, out, err }: 0 report on `out`, 3 broken ledger. A slug with no ledger is bad input (exit 2).
export function renderReport(slug, { root = '.', md = false } = {}) {
  const f = files(slug, root);
  if (!existsSync(f.ledger)) throw new GateInputError(`no ledger at ${f.ledger}`);
  const { events, broken } = load(f.ledger);
  if (broken) return broken;
  const last = events.findLast((e) => e.type === 'verdict.issued');
  const n = events.length;
  const footer = [
    `chain head: ${n ? events.at(-1).hash : 'none'}`,
    `verify: ok (${n} line${n === 1 ? '' : 's'})`,
    `verdict: ${last ? `${last.data.verdict} (seq ${last.seq})` : 'not issued'}`,
  ].map((l) => (md ? `- ${l}` : l));
  const title = `${md ? '## ' : ''}councilkit report: ${slug}`;
  return { code: 0, out: `${title}\n\n${table(events.map(row), md)}\n\n${footer.join('\n')}\n`, err: '' };
}
