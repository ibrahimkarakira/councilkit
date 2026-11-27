# The `codex` adapter

`lib/adapters/codex.mjs` runs [Codex CLI](https://github.com/openai/codex) non-interactively as a reviewer or judge.
Pick it with `"adapter": "codex"` in `councilkit.json` ([config](config.md)).

## What it runs

```
codex exec --json --output-schema <tmp>/schema.json -o <tmp>/last-message.txt --sandbox read-only [-m <model>] -
```

- The prompt goes on stdin (`-`). The working root is the request's `cwd`, set as the process working directory, so `--cd` is not passed.
- `--output-schema` is passed only when the request has a schema; the schema is written to a temp file that is removed after the run.
- The reply is the `-o` file (the last agent message), parsed as JSON. If the file is missing, the text of the last `item.completed` `agent_message` event is used.
- `timeout_s` (request, then config, then 600) bounds the run; on timeout the whole process tree is killed and the result is `codex timed out after <n> s`.
- No `codex` on `PATH` gives `codex not found on PATH; install it or switch adapter`.

## Sandbox

`sandbox` in the config is `read-only` (the default) or `workspace-write`. `danger-full-access` and any other value are refused before Codex is started, so the adapter can never produce it. `--dangerously-bypass-approvals-and-sandbox` is never passed.

## Flags and events, as checked

Checked on 2026-11-28 in the Codex CLI source (`codex-rs/exec/src/cli.rs`, `codex-rs/utils/cli/src/shared_options.rs`, `codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs`, `codex-rs/exec/src/exec_events.rs`, `codex-rs/exec/src/lib.rs`, `sdk/typescript/src/events.ts`) through Context7 (`/openai/codex`). Codex CLI is not installed on the machine that wrote this adapter, so none of it has been run against a real `codex` yet.

| Flag or behaviour | Resolved | Used |
|---|---|---|
| `--json` | Prints events to stdout as JSONL (alias `--experimental-json`). | yes |
| `--output-schema FILE` | JSON Schema file for the final response shape. | when the request has a schema |
| `-o`, `--output-last-message FILE` | Writes the agent's last message to FILE; independent of `--output-schema`. | yes |
| `-s`, `--sandbox` | `read-only`, `workspace-write` or `danger-full-access`. | `read-only` or `workspace-write` only |
| `-m`, `--model` | Model the agent should use. | when `model` is set |
| `-C`, `--cd DIR` | Use DIR as the agent's working root. | no (process cwd instead) |
| `-` as the prompt | Forces the prompt to be read from stdin; an empty stdin exits 1. | yes |
| Exit code | 1 after a failed or interrupted turn or a non-retrying error; otherwise 0. Other codes are `[UNCLEAR]`. | non-zero without an error event is `codex exited with code <n>` |
| `turn.failed` event | `{"type":"turn.failed","error":{"message":...}}` | becomes `ok:false` with that message |
| `error` event | `{"type":"error","message":...}`, unrecoverable stream error | becomes `ok:false` with that message |
| `item.completed` | `{"type":"item.completed","item":{"id":...,"type":"agent_message","text":...}}`; text is JSON when a schema is given | fallback reply |

`[UNCLEAR]` until a live run is recorded: whether `codex exec` refuses to run outside a git repository without `--skip-git-repo-check` (not passed), and the vendor page https://learn.chatgpt.com/docs/non-interactive-mode, which could not be fetched for this check.

## Tests

`test/codex.test.mjs` puts a fake `codex` (`test/bin/codex`, plus `codex.cmd` for Windows) first on `PATH`. It replays the hand-written transcripts in `fixtures/codex/synthetic-*.jsonl`, built from the event list above and labelled `synthetic`; they are not recordings of a real run. `scripts/record-live.mjs` re-records the demo transcripts from a real `codex` (see CONTRIBUTING.md); no live recording has been made yet.
