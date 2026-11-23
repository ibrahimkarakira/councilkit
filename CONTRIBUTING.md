# Contributing

Thanks for your interest in councilkit.

## Requirements

- Node.js 22 or later. The project has no npm dependencies.
- Claude Code CLI on your PATH (`claude`), used to validate the plugin manifest.
- Docker, only for the optional Linux run.

## Local checks

There is no hosted CI. Before opening a pull request, run:

```sh
node scripts/check.mjs
```

It runs, in order, and stops on the first failure:

1. `node --check` on every `.mjs` file (syntax lint)
2. `node --test`
3. `claude plugin validate --strict .`

To rerun the tests on Linux in `node:22` and `node:24` containers:

```sh
node scripts/check.mjs --docker
```

Paste the command and its output (with the exit code) into the pull request.

## Pull requests

- Open or link an issue first; one issue per pull request.
- Keep pull requests small and focused.
- Write a failing test before the fix or feature.
- Examples and fixtures must be synthetic. Do not include private or third-party material.
- If an AI tool helped write the change, say so in the pull request description.

By contributing you agree that your contributions are licensed under the Apache License 2.0.
