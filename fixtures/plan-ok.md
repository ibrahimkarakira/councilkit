# Plan: add-json

## Goal
Add a `--json` flag to the `list` command so scripts can read its output without parsing text.

## Acceptance
- `list --json` prints a JSON array of item names, and `[]` when there are no items.
- Without `--json` the text output is unchanged.
