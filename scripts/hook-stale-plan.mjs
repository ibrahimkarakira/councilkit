#!/usr/bin/env node
// PreToolUse hook on the Agent tool (registered in hooks/hooks.json): refuses to launch a councilkit
// lens reviewer while any plan under .councilkit/ fails the stale-plan gate, so the gate holds even
// when the panel skill is skipped. Every other tool call, and every project without .councilkit/,
// is allowed silently (exit 0, no output). Read-only: it never writes to a ledger; only the CLI
// `gate review` records gate.blocked.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkReview } from '../lib/gate.mjs';

// Claude Code namespaces plugin agents as `<plugin>:<agent>` (code.claude.com/docs/en/plugins-reference,
// "name"). Matches the lens agents in agents/lens-<name>.md.
const LENS_PREFIX = 'councilkit:lens-';

// Slugs that have a plan.md; an empty list when .councilkit/ does not exist.
function slugs(root) {
  const dir = join(root, '.councilkit');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'plan.md')))
    .map((e) => e.name);
}

// The deny reason, or null to allow.
// Known limit: checks every slug, so one abandoned stale plan blocks all lens launches; scope by slug
// once the panel skill passes its slug to the agent.
function decide(input, root) {
  if (input?.tool_name !== 'Agent') return null;
  const agent = input.tool_input?.subagent_type;
  if (typeof agent !== 'string' || !agent.startsWith(LENS_PREFIX)) return null;
  const blocked = slugs(root).flatMap((slug) => {
    try {
      const r = checkReview(slug, { root });
      if (r.broken) return [`${slug}: ${r.broken.err.trim()}`];
      return r.reason ? [`${slug}: ${r.reason}`] : [];
    } catch (e) {
      return [`${slug}: ${e.message}`];
    }
  });
  if (!blocked.length) return null;
  return `councilkit stale-plan gate: ${blocked.join('; ')}. Re-run plan review or \`councilkit plan rebind\` first.`;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (e) {
    process.stderr.write(`councilkit hook: cannot parse hook input: ${e.message}\n`);
    return 1; // non-blocking error: never break a session over bad input
  }
  const root = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  const reason = decide(input, root);
  if (reason) {
    const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    process.stdout.write(`${JSON.stringify(out)}\n`);
  }
  return 0;
}

process.exitCode = main();
