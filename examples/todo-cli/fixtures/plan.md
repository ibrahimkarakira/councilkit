# Plan: add-json

## Goal
Add a `--json` flag to `todo list` so scripts can read the list without parsing text.

## Acceptance
- `todo list --json` prints a JSON array of item names, and `[]` when there are no items.
- Without `--json` the text output is unchanged.

## Non-goals
- No other command gets a `--json` flag.

## Files
- `todo.mjs`: the `list --json` branch.
- `todo.test.mjs`: one test for `--json`.

## Test plan
- A test that `list --json` prints `[]` on an empty list and the names after two adds, run with `node --test`.
