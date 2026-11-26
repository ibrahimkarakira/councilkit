# Quickstart: the whole pipeline without a model

`scripts/demo.mjs` runs every councilkit step on `examples/todo-cli/`, an invented 40-line todo list
with one test. No model is called: the two plan reviewers and the judge answer from recorded
transcripts through the `replay` adapter (`examples/todo-cli/councilkit.json`), and the panel's lens
replies are recorded files. Nothing outside a temporary directory is written.

## Install

You need Node.js 22 or later and git. There are no dependencies to install.

```sh
git clone https://github.com/ibrahimkarakira/councilkit
cd councilkit
```

## Run

```sh
node scripts/demo.mjs
```

It copies `examples/todo-cli/` into a temporary git repository and runs, through `bin/councilkit`:

1. **plan**: copies `fixtures/plan.md` to `.councilkit/add-json/plan.md`, runs `plan lint` and records `plan.created`.
2. **plan review**: asks each reviewer in `councilkit.json` (`alpha`, `beta`) through the replay adapter and records each reply as `review.submitted` in round 1. `alpha` calls the missing empty-list check a blocker, `beta` calls it minor, so the finding is contested.
3. **judge**: `councilkit judge --round 1` sends only that contested finding to the replay judge, which dismisses it.
4. **build**: applies `fixtures/build.patch` (the `list --json` change and its test), commits it and runs `councilkit build record --test 'node --test'`, then `gate merge`.
5. **panel**: `councilkit panel --json` sizes the panel from the diff, and each selected lens's recorded reply in `fixtures/panel/` goes through `councilkit review ingest` in round 2.
6. **verdict** and **report**, then `councilkit ledger verify`.

The exit code is 0 only when every step did what it should. The chain head hash is left out of the
printed report because it covers timestamps; everything else is the same on every run.

## Expected output

`test/demo.test.mjs` runs the demo and compares its output with this block, so the two cannot drift.

```text
councilkit demo: examples/todo-cli in a temporary git repository, replay adapter, no model

== plan
ok: .councilkit/add-json/plan.md
plan.created seq 1, plan_sha sha256:16556053d050ae92f76f862c692f79ec973d59269c249c27037edb2ce165639a

== plan review (round 1, replay)
alpha: changes (1 blocker)
beta: approve (1 minor)

== judge (round 1, replay)
contested: 1 of 1  uncontested: 0
ruling: dismiss Acceptance|testability

== build
build.recorded seq 5: diff_lines 16, exit 0
gate merge: ok

== panel (round 2, recorded lens replies)
16 changed lines, tier 1: correctness, acceptance
correctness: approve (0 findings)
acceptance: approve (1 nit)

== verdict
verdict: approve

== report
councilkit report: add-json

seq  event             round  actor                 verdict  findings   contested  rulings                         plan
1    plan.created             cli/councilkit                                                                       16556053d050
2    review.submitted  1      reviewer/replay       changes  1 blocker                                             16556053d050
3    review.submitted  1      reviewer/replay       approve  1 minor                                               16556053d050
4    judge.ruled       1      judge/replay                              1          dismiss Acceptance|testability  16556053d050
5    build.recorded           build/councilkit      exit 0                                                         16556053d050
6    review.submitted  2      reviewer/claude-code  approve  0                                                     16556053d050
7    review.submitted  2      reviewer/claude-code  approve  1 nit                                                 16556053d050
8    verdict.issued    2      verdict/councilkit    approve                                                        16556053d050

verify: ok (8 lines)
verdict: approve (seq 8)

verify: ok
```

## Try it on your own repository

Load the plugin for one session with `claude --plugin-dir <path to this clone>`, then use
`/councilkit:plan`, `/councilkit:build`, `/councilkit:panel` and `/councilkit:report`. The plan review and
judge steps call the adapters in your `councilkit.json` ([config](config.md)); until the `codex`
adapter lands, only `replay` runs, so a live review round is not possible yet.
