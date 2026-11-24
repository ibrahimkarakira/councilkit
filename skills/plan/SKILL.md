---
name: plan
description: Write a councilkit plan (Goal, Acceptance, Non-goals, Files, Test plan) to .councilkit/SLUG/plan.md and record it in the evidence ledger. Run it by hand before a review round.
disable-model-invocation: true
argument-hint: "[slug] [one-line task]"
---

Write the plan for the task below and record it in the councilkit ledger.

- Arguments: $ARGUMENTS
- Slug: `$0` (the first argument); the rest of the arguments is the one-line task.

Steps:

1. If the slug is missing or is not letters, digits, `.`, `_` or `-` (starting with a letter or digit), stop and ask for one. If `.councilkit/$0/plan.md` already exists, stop and ask whether to replace it; never overwrite it silently.
2. Read the code the task touches, then write `.councilkit/$0/plan.md` from [template.md](template.md) (also at `${CLAUDE_SKILL_DIR}/template.md`). Keep the five `##` headings exactly as written: Goal, Acceptance, Non-goals, Files, Test plan. Replace every placeholder line in angle brackets and delete the HTML comment. Each Acceptance item must be checkable by a command or an observation.
3. Run `councilkit plan lint .councilkit/$0/plan.md`. Exit 2 names each missing section: add it and run the lint again until it exits 0.
4. Record the plan: `councilkit ledger append --slug $0 --type plan.created --data '{"path":".councilkit/$0/plan.md"}'`. The ledger stores the plan's hash, so later review rounds are bound to this exact text.
5. Report the plan path and the `plan_sha` from the appended ledger line. Do not start implementing.
