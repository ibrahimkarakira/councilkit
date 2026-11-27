# councilkit

Vendor-neutral multi-model delivery pipeline for Claude Code: plan, cross-model review, judge on disagreements, diff-sized panel, hash-chained evidence ledger. Work in progress; no live model adapter exists yet.

Try the whole pipeline offline, no model or API key needed: `node scripts/demo.mjs` ([quickstart](docs/quickstart.md)). To check ledgers in your own CI, paste `councilkit digest` into the PR and run `councilkit verify --ci` ([CI guide](docs/ci.md)).

Tested on Windows 11 and on Linux (`node:22` and `node:24` in Docker), which compute the same plan hashes; macOS is `[UNCLEAR]` until a user confirms ([platform notes](docs/windows.md)).
