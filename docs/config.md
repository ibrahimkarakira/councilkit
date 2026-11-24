# Config: `councilkit.json`

Status: the loader and validator exist (`lib/config.mjs`, `loadConfig(dir)`), but no command reads `councilkit.json` yet, and the CLI still writes to `.councilkit/` whatever `dir` says. The meanings below describe planned behaviour.

One file at the repo root will drive the reviewers, the judge, the review panel tiers and the rules. It is optional: without it `loadConfig` returns the defaults below. `schemas/config.schema.json` describes the file as written, partial files included, for editors; `lib/config.mjs` is authoritative and also checks what the schema cannot (unique reviewer ids, ascending tiers).

## Example

The test suite (`test/config.test.mjs`) loads this exact block, so it cannot drift from the code.

```json
{
  "version": 1,
  "dir": ".councilkit",
  "reviewers": [
    { "id": "codex", "adapter": "codex", "model": null, "sandbox": "read-only", "timeout_s": 600 },
    { "id": "second", "adapter": "command", "command": ["my-review-cli", "--json"], "timeout_s": 600 }
  ],
  "judge": { "adapter": "codex", "model": null, "timeout_s": 600 },
  "panel": {
    "tiers": [
      { "max_changed_lines": 50,  "lenses": ["correctness", "acceptance"] },
      { "max_changed_lines": 400, "lenses": ["correctness", "acceptance", "tests"] },
      { "max_changed_lines": null, "lenses": ["correctness", "acceptance", "tests", "security", "performance"] }
    ]
  },
  "rules": { "max_fix_rounds": 3, "blocker_severities": ["blocker"], "block_on_stale_plan": true }
}
```

`my-review-cli` is a placeholder for any command that reads a prompt on stdin and prints JSON.

## Keys

| Key | Meaning | Default |
|---|---|---|
| `version` | Config format version. Must be `1`. | `1` |
| `dir` | Where ledgers and plans will live. | `.councilkit` |
| `reviewers` | Non-empty list. Each has a unique `id` and an `adapter` (`codex`, `command` or `replay`); optional `model` (`null` = the adapter's default), `sandbox`, `timeout_s` (integer seconds, at least 1). `command` adapters need `command`, an argv array. | one `codex` reviewer, read-only, 600 s |
| `judge` | One adapter, same fields as a reviewer without `id`. Will run only on contested findings. | `codex`, 600 s |
| `panel.tiers` | Will size the panel by diff size. `max_changed_lines` must strictly increase from tier to tier; `null` means "no upper bound" and is allowed only on the last tier. `lenses` is a non-empty list. | the three tiers above |
| `rules.max_fix_rounds` | Integer, at least 1. | `3` |
| `rules.blocker_severities` | Severities that will block. | `["blocker"]` |
| `rules.block_on_stale_plan` | Will block when the plan changed after review. | `true` |

No model names are baked in. A file may set only some keys: missing top-level keys take the defaults, and `judge`, `panel` and `rules` merge one level deep over theirs (so `{"rules":{"max_fix_rounds":5}}` keeps the other two rules).

## Errors

Unknown keys and bad values are rejected, and every problem is reported with its path, for example:

```
/path/to/repo/councilkit.json: panel.tiers[1].max_changed_lines must be greater than the previous tier
```
