# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- Add the Claude Code plugin manifest and the local check script `scripts/check.mjs` (#1).
- Add normalised plan hashing (`lib/plan-hash.mjs`) and `councilkit plan hash <file>` (#3).
- Add the hash-chained evidence ledger library (`lib/ledger.mjs`: canonical JSON, `append`, `verify`) and its line schema (#9).
- Add `councilkit ledger append|show|verify --slug <s>` (exit 2 on bad input, 3 on a broken chain) (#10).
- Add the `councilkit.json` loader (`lib/config.mjs`: defaults, per-section merge, path-style errors), its schema and `docs/config.md` (#11).
- Add the `/councilkit:plan` skill and plan template, and `councilkit plan lint <file>` (exit 2 names each missing required section) (#12).
- Add the finding schema and contest detection (`lib/findings.mjs`: `contested`, `uncontestedBlockers`, `uncontestedRest`), so only disagreements reach the judge (#13).
- Add the stale-plan gate: `councilkit gate review --slug <s>` exits 2 and records `gate.blocked` when `plan.md` no longer matches the plan of record, and `councilkit plan rebind --slug <s> --reason '<text>'` records a `plan.rebound` (#14).
- Add the adapter interface (`lib/adapters/index.mjs`, `getAdapter`) and the offline `replay` adapter, which answers from `fixtures/transcripts/<sha256>.json` and returns `no transcript for sha256:<key>` on a miss; `scripts/record-transcript.mjs` records transcripts and refuses any that contain a home path or an e-mail address (#15).
- Add the judge: `councilkit judge --slug <s> --round <n>` sends only the contested findings and the plan sections they anchor to (`lib/judge.mjs`, `prompts/judge.md`, read-only `agents/judge.md`), records one `judge.ruled` per contested key (`uphold`, `dismiss` or `needs-human`, or `ruling: "none"` without calling the adapter when nothing is contested), and a `needs-human` ruling makes `gate review` exit 2 (#19).
- Add the stale-plan hook: a `PreToolUse` hook on the `Agent` tool (`hooks/hooks.json`, `scripts/hook-stale-plan.mjs`) denies launching a `councilkit:lens-*` reviewer while any plan under `.councilkit/` fails the `gate review` check, without writing to the ledger, and allows every other tool call and every project without `.councilkit/`. No lens agent exists yet: the prefix is reserved for the lens agents added in #22, so until then the hook allows every launch (#20).
