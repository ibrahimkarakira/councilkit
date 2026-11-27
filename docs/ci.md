# Verify the ledger in CI

A ledger proves its own order: every line carries the hash of the line before it, so an edited or
reordered line fails `councilkit ledger verify`. It cannot prove its own length. Delete the last lines
and what is left is still a valid chain, so plain `verify` passes. That is a documented limit, not a
bug. The fix is to record the chain head somewhere the ledger file cannot rewrite: the PR body.

## 1. Paste the digest into the PR

```sh
node bin/councilkit digest --slug add-json
```

prints one line, for example:

```text
councilkit-ledger: add-json seq=9 head=sha256:<64 hex> plan=sha256:<64 hex>
```

`seq` is the number of lines, `head` the hash of the last line and `plan` the `plan_sha` of the last
line. Paste the line into the PR description, one line per ledger under `.councilkit/`. Reviewers see
it, and the PR keeps its edit history.

## 2. What `verify --ci` checks

```sh
node bin/councilkit verify --ci [--dir .councilkit] [--heads <file>]
node bin/councilkit verify --slug <s> [--expect-head sha256:<64 hex>]
```

`verify --ci` walks every `<dir>/<slug>/ledger.jsonl` (default `--dir .councilkit`) and checks, per
ledger:

1. the hash chain is intact;
2. the last line's `plan_sha` equals the hash of `<slug>/plan.md` as checked out, so a plan edited
   after its last recorded event fails;
3. with `--heads <file>`: the file holds a `councilkit-ledger:` line for the slug and its `head`
   equals the ledger's last hash, so a truncated ledger fails. A ledger with no line in the file fails
   too: a missing anchor is not a pass. The line may sit anywhere in the file, inside prose or
   backticks.

`verify --slug <s> --expect-head <hash>` does the same head check for one ledger.

Exit codes: 0 every check passed, 2 bad usage, a missing `--dir` or an unreadable `--heads` file, 3 a
broken chain, a plan that does not match, or a head that does not match or is missing.

The anchor is only as strong as the place it lives. The PR author writes the PR body, so the head
check stops silent truncation, not an author who rewrites both the ledger and the pasted line; a
reviewer reading the PR, or a signed digest stored elsewhere, covers that case.

## 3. GitHub Actions

This repository runs no workflows. The snippet is for your repository: save it as
`.github/workflows/councilkit.yml`. It checks out councilkit next to your code and runs
`bin/councilkit` with Node, so neither `npm install` nor `npx` is needed. `edited` is in the trigger
types so that changing the pasted line in the PR body runs the check again. The PR body reaches the
script through `env`, never inside the `run:` text, so it cannot inject shell commands. Actions are
pinned by full commit SHA; replace the councilkit `ref` with the commit or tag you reviewed.

```yaml
name: councilkit ledger
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]
permissions:
  contents: read
jobs:
  ledger:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: ibrahimkarakira/councilkit
          ref: REPLACE-WITH-A-COUNCILKIT-COMMIT-SHA
          path: councilkit
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - name: Save the PR body, which holds the pasted digest lines
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
        run: node -e "require('fs').writeFileSync('councilkit-heads.txt', process.env.PR_BODY || '')"
      - name: Verify every ledger against its plan and its pasted head
        run: node councilkit/bin/councilkit verify --ci --heads councilkit-heads.txt
```

`test/ci-snippet.test.mjs` takes the two `run:` lines above, runs them on this laptop against the
demo's ledger (`scripts/demo.mjs`) with `PR_BODY` set to its digest line, and expects exit 0, then exit
3 after the plan is edited.
