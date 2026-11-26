---
name: build
description: Implement a recorded councilkit plan from .councilkit/SLUG/plan.md without changing the plan, commit the change, then run the tests through councilkit build record so the base commit, head commit, diff size and test exit code land in the evidence ledger. Run it by hand after the plan is recorded.
disable-model-invocation: true
argument-hint: "[slug] [base-ref] [test command]"
---

Build the change described by the recorded plan and record how it was tested.

- Arguments: $ARGUMENTS
- Slug: `$0`. Base ref: `$1` (default `main`). The rest of the arguments is the test command (ask for it if missing).

Steps:

1. If the slug is missing or is not letters, digits, `.`, `_` or `-` (starting with a letter or digit), stop and ask for one.
2. Run `councilkit gate review --slug $0`. If it exits non-zero, show its message and stop: the plan changed since it was recorded or rebound, a judge asked for a human, or the ledger is broken.
3. Read `.councilkit/$0/plan.md` and implement exactly what it says, within its Files and Non-goals. Never edit `plan.md` during the build. If the plan is wrong or incomplete, stop and say what should change: the human edits the plan and runs `councilkit plan rebind`, which is the only way a changed plan becomes the plan of record.
4. Commit the change. The recorder ties the test result to `HEAD`, so it refuses (exit 2, nothing recorded) while anything outside `.councilkit/` is uncommitted or untracked.
5. Run `councilkit build record --slug $0 --base <base-ref> --test '<test command>'`. It runs the command through the shell (`sh`, or `cmd.exe` on Windows; quote for that shell) with a timeout (`--timeout <seconds>`, default 600) and appends one `build.recorded` event. Exit 0 means the tests passed; exit 1 means they failed or timed out and that result is recorded too. Do not rerun until it passes without fixing the code first: every run is evidence.
6. Report the `head_sha`, `diff_lines`, `exit` and `duration_ms` from the appended ledger line. `councilkit gate merge --slug $0` now passes only while `HEAD` and `plan.md` stay as recorded and the latest build for `HEAD` exited 0.
