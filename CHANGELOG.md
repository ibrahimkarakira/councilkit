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
