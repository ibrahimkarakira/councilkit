---
name: plan-review
description: Ask every reviewer in councilkit.json (other models through their adapters) to review the recorded plan, record each reply in the evidence ledger bound to the plan hash, and show which findings are contested. Run it by hand after /councilkit:plan and before building.
disable-model-invocation: true
argument-hint: "[slug] [round]"
---

Run a cross-model review of the recorded plan and show the contested set.

- Arguments: $ARGUMENTS
- Slug: `$0`. Round: `$1` (optional; without it the next round after the last recorded one is used).

Steps:

1. If the slug is missing or is not letters, digits, `.`, `_` or `-` (starting with a letter or digit), stop and ask for one.
2. Run `councilkit gate review --slug $0`. If it exits non-zero, show its message and stop: the plan changed since it was recorded or rebound, a judge asked for a human, or the ledger is broken. Do not edit the plan to make the gate pass.
3. Run `councilkit review run --slug $0 --target plan`, adding `--round $1` when a round was given. It sends the plan and `prompts/plan-review.md` to every reviewer in `councilkit.json` in parallel and appends one `review.submitted` per reviewer. Exit 0 records every reply; exit 1 means at least one reviewer failed or replied with something that is not a valid findings object, and that reply was recorded as `verdict: "error"`. Do not retry a reviewer to make it succeed; run the command again for a new round if needed. Exit 2 with `max_fix_rounds` means the round cap in `councilkit.json` was reached with blockers left: show the message and stop; a human decides whether to revise the plan and `councilkit plan rebind` or stop.
4. Show its output unchanged: the round, one line per reviewer (verdict and findings by severity) and the `contested:` line with the contested keys (`anchor|category`).
5. If anything is contested, say that `councilkit judge --slug $0 --round <round>` rules on exactly those keys. Do not fix the plan or rule on findings in this skill.
