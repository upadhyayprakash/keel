# Contributing to Keel

Thanks for your interest. Keel is young, so ideas and bug reports are as welcome as code. Open an issue with the templates provided.

## Ground rules

- Open an issue before a large change, so we can agree on the approach first.
- Keep personal data out of the repo. Use fictional names (Acme, Northwind) in examples, tests and screenshots.
- Configuration goes through environment variables (see `.env.example`), never hardcoded paths, hosts or tokens.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` ...).

## Setup

```bash
pnpm install
pnpm test && pnpm typecheck
pnpm keel today         # run from source
```

Add user-facing changes to `CHANGELOG.md` under Unreleased.

## Writing style

Plain, short sentences. No em dashes: use a period, comma, colon or parentheses instead.

## Releasing (maintainers)

1. Move the Unreleased notes in `CHANGELOG.md` under a new version heading and add its compare link.
2. Bump `version` in `apps/cli/package.json` and `VERSION` in `packages/core/src/version.ts` (a test checks they match).
3. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
4. The Release workflow checks, builds, stages `@nouisi/keel` on npm through trusted publishing (no token), and creates the GitHub release with the changelog notes.
5. Approve the staged version on npmjs.com (it asks for your 2FA code). Until then nobody can install it.

## License

By contributing you agree that your contributions are licensed under the MIT License (see `LICENSE`).
