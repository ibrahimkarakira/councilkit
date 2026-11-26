---
name: report
description: Issue the councilkit verdict for a recorded plan (approve or changes) and print the evidence ledger as a table a reviewer can read in a PR, with the chain head hash and the verify result. Run it by hand at the end of a run, after the panel and the build are recorded.
disable-model-invocation: true
argument-hint: "[slug]"
---

Decide the run and show its evidence.

- Arguments: $ARGUMENTS
- Slug: `$0`.

Steps:

1. If the slug is missing or is not letters, digits, `.`, `_` or `-` (starting with a letter or digit), stop and ask for one.
2. Run `councilkit verdict --slug $0`. It appends one `verdict.issued` event and prints `verdict: approve` (exit 0) or `verdict: changes` (exit 2) followed by one line per reason. `approve` needs all of: the review gate passes (plan unchanged since it was recorded or rebound, no `needs-human` ruling), the latest review round has at least one review and none is `verdict: "error"`, every blocker in that round is dismissed by a `judge.ruled` for its key in the same round, and the latest `build.recorded` for the current `HEAD` exited 0. Exit 3 means the ledger chain is broken: show the message and stop.
3. Run `councilkit report --slug $0 --md` and show its output unchanged. It is read-only: one table row per ledger event (round, actor, verdict, findings by severity, contested count, judge rulings, short plan hash), then the chain head hash, `verify: ok` and the latest verdict.
4. If the verdict is `changes`, list its reasons as the fix list. Do not fix anything in this skill and do not edit the ledger.
