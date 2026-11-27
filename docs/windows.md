# Windows, Linux and macOS

A review binds to the plan hash, so a Windows user and a Linux user must compute the same `plan_sha` for the same plan. `councilkit plan hash` ignores a leading BOM, CRLF line endings and trailing spaces or tabs, and `.gitattributes` checks markdown out as LF on every OS. The two CRLF fixtures (`fixtures/plan-crlf.md`, `fixtures/plan-unicode-crlf.md`) are `-text`, so they stay byte-exact.

## Checked hashes

`node scripts/check.mjs` prints the hash of each fixture after the tests, and `node scripts/check.mjs --docker` prints them again in each Linux image (`node scripts/check.mjs --hashes` prints only the hashes). `test/portability.test.mjs` pins the values, so a mismatch on any OS fails the suite.

Run on 2026-11-28, Windows 11 and Docker Desktop (Linux containers, repository bind-mounted with `-v`):

| fixture | Windows 11, node v24.13.1 | Linux, node v22.23.5 | Linux, node v24.22.3 |
|---|---|---|---|
| `plan-ok.md`, `plan-crlf.md` | `sha256:1e885578…cee7` | same | same |
| `plan-unicode.md`, `plan-unicode-crlf.md` (non-ASCII, BOM, CRLF, tabs) | `sha256:637aacfd…aa3f` | same | same |

macOS: `[UNCLEAR]`. It cannot be run here; it stays unconfirmed until a user reports a run of `node scripts/check.mjs`.

## Running the CLI on Windows

| route | shell | result |
|---|---|---|
| `node bin/councilkit plan hash fixtures/plan-ok.md` | any | works, exit 0 |
| `bin/councilkit plan hash fixtures/plan-ok.md` | Git Bash | works, exit 0 (the `#!/usr/bin/env node` line is honoured) |
| `bin\councilkit plan hash fixtures\plan-ok.md` | cmd.exe | fails: `'bin\councilkit' is not recognized`, exit 1 |
| `./bin/councilkit ...` | PowerShell | `[UNCLEAR]`, not tried: Windows has no handler for an extensionless file and may open a "choose an app" dialog |

So on Windows outside Git Bash, call it as `node bin/councilkit`. Claude Code puts the plugin's `bin/` on the `PATH` of its Bash tool's shell, so inside Claude Code the bare `councilkit` name takes the shebang route.
