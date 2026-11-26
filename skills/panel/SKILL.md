---
name: panel
description: Run the councilkit review panel on the current diff, one lens agent (no Write or Edit) per lens the diff size selects, launched in parallel, and record each lens's findings in the evidence ledger. Run it by hand after building from an approved plan.
disable-model-invocation: true
argument-hint: "[slug] [base-ref] [round]"
---

Run the review panel for the plan below and record every lens's findings.

- Arguments: $ARGUMENTS
- Slug: `$0`. Base ref: `$1` (default `main`). Round: `$2` (default `1`; use the next number for each fix round).

Steps:

1. If the slug is missing or is not letters, digits, `.`, `_` or `-` (starting with a letter or digit), stop and ask for one.
2. Run `councilkit gate review --slug $0`. If it exits non-zero, show its message and stop: the plan changed since it was recorded or rebound, a judge asked for a human, or the ledger is broken, and the panel must not review it. (The build recorder, roadmap D17, adds `gate merge`, which also checks that the build is recorded; this step switches to it then.)
3. Run `councilkit panel --base <base-ref> --json`. It prints `{"changed_lines": n, "tier": t, "lenses": [...], "binary": [...]}`.
4. Launch one `councilkit:lens-<lens>` agent for every name in `lenses`, all in the same turn so they run in parallel. Give each the slug and the base ref and nothing else; do not pass one lens's output to another.
5. For each lens, pass its reply unchanged to `councilkit review ingest --slug $0 --lens <lens> --round <round>` on stdin (or save it to a file under `.councilkit/$0/` and pass `--file <path>`). Exit 0 records the findings; exit 1 means the reply was not a valid findings array and was recorded as `verdict: "error"`. Do not edit or retry a reply to make it valid.
6. Report a table: lens, verdict, number of findings by severity. List every `blocker` finding with its anchor and claim. Do not fix anything in this skill.
