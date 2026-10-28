# Keel development and release guide

How a change to Keel goes from your editor to `npm install -g @nouisi/keel`, written for someone who knows basic Git and GitHub (clone, commit, push, pull request) and nothing more. Part 1 explains how the pipeline works. Parts 2 to 4 are step-by-step procedures to follow. Part 5 is what to do when something fails.

The 0.4.0 release (17 Oct 2026) is the worked example throughout.

**Contents**

- [At a glance](#at-a-glance)
- [Part 1. How it works](#part-1-how-it-works)
- [Part 2. SOP: make a change](#part-2-sop-make-a-change)
- [Part 3. SOP: release a version](#part-3-sop-release-a-version)
- [Part 4. SOP: after the release](#part-4-sop-after-the-release)
- [Part 5. When something goes wrong](#part-5-when-something-goes-wrong)
- [Part 6. Worked example: 0.4.0](#part-6-worked-example-040)
- [Part 7. Not set up yet](#part-7-not-set-up-yet)
- [Cheat sheet](#cheat-sheet)

## At a glance

```text
  you                       GitHub                          GitHub Actions                     npm
  ───                       ──────                          ──────────────                     ───
  commit on a branch
        │
        ▼
  push to main  ─────────►  main updated  ───────────────►  CI: typecheck, tests, build,
  (or merge a PR)                                           docs check, package smoke test,
                                                            tests on file + libSQL server
        │                                                   (publishes nothing)
        ▼
  release commit
  (version + changelog)
        │
        ▼
  push tag v0.4.0  ───────►  tag v0.4.0  ─────────────────►  Release: same checks, tag must
                                                            match the version, pack, then
                                                            stage on npm  ─────────────────►  0.4.0 STAGED
                                                            + GitHub release with notes          │
                                                                                                 ▼
                                                                                  you approve on npmjs.com
                                                                                  with 2FA (the gate)
                                                                                                 │
                                                                                                 ▼
                                                                                  0.4.0 is "latest";
                                                                                  npm install -g works
```

Three rules hold the whole pipeline together:

1. **Pushing to `main` never publishes.** It only runs checks.
2. **Pushing a tag that starts with `v` starts a release.** Nothing else does.
3. **A release isn't public until a person approves it on npm.** The workflow stages it; you release it.

## Part 1. How it works

### 1.1 The repository

| | |
|---|---|
| Repository | `github.com/upadhyayprakash/keel`, public, default branch `main` |
| Package manager | pnpm 9.15.9 (pinned in `package.json` as `packageManager`), Node 20.19 or newer |
| Layout | A pnpm workspace (`pnpm-workspace.yaml`: `packages/*` and `apps/*`) |
| Published to npm | Only `@nouisi/keel` (`apps/cli`). Everything else is private and gets bundled into it |
| Docs site | `docs-site/` (Mintlify), live at nouisi-keel.mintlify.site |
| Claude Code plugin | `.claude-plugin/marketplace.json` and `plugins/claude/`, installed straight from GitHub (no npm) |

```text
packages/core     @keel/core     private   commands, parser, database (Drizzle + libSQL), tests
apps/server       @keel/server   private   `keel serve`: the HTTP API for the browser terminal
apps/web          @keel/web      private   the browser terminal (Vite + React)
apps/cli          @nouisi/keel   PUBLIC    the `keel` command; the only thing on npm
apps/goals                                 groundwork for Goals, not shipped
docs-site/                                 the Mintlify docs (some pages generated from code)
docs/                                      design notes and ADRs (architecture decisions)
plugins/claude/                            the Claude Code plugin
.github/workflows/ci.yml                   checks on every push to main and every pull request
.github/workflows/release.yml              the release, on every v* tag
```

### 1.2 How the npm package is built

`pnpm build` at the root runs two builds in order:

1. `@keel/web` builds the browser terminal into `apps/web/dist`.
2. `@nouisi/keel` runs `tsup` (`apps/cli/tsup.config.ts`), which makes **one file**, `apps/cli/dist/keel.js`:
   - Keel's own private packages (`@keel/core`, `@keel/server`) are bundled into it, which is why they never need publishing.
   - Third-party dependencies stay external and are installed by npm (libSQL ships native binaries per platform).
   - The database migrations (`packages/core/drizzle`) and the built browser terminal (`apps/web/dist`) are copied next to it.

When the package is packed, `apps/cli/scripts/prepack.mjs` copies in the `LICENSE` and refuses to continue if `dist/keel.js`, the migrations or the web build are missing. npm only ships what `files` in `apps/cli/package.json` lists: `dist`, `README.md`, `LICENSE`.

### 1.3 The version lives in two places

| File | Field |
|---|---|
| `apps/cli/package.json` | `"version": "0.4.0"`: what npm sees |
| `packages/core/src/version.ts` | `VERSION = '0.4.0'`: what `keel --version` prints |

A test fails if they differ, and the Release workflow refuses a tag that doesn't match `package.json`.

Versions follow [semantic versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`). While Keel is `0.x`:
- new features, or anything users will notice, bump MINOR (0.3.1 to 0.4.0);
- fixes only bump PATCH (0.4.0 to 0.4.1).

### 1.4 The changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):
- every user-facing change goes under `## [Unreleased]` as it's made, in `Added`, `Changed` or `Fixed`;
- at release time those notes move under `## [0.4.0] - date`;
- the Release workflow copies exactly that section into the GitHub release;
- the docs site's changelog page is generated from this file.

### 1.5 CI: the checks on every push to `main` and every pull request

`.github/workflows/ci.yml`. A newer push cancels a run still going on the same branch. Two jobs:

**Typecheck, test, build** (Node 20):
1. `pnpm install --frozen-lockfile`: fails if `pnpm-lock.yaml` doesn't match the `package.json` files.
2. `pnpm typecheck`, `pnpm test`, `pnpm build`.
3. **Docs site matches the code**: runs `pnpm docs:generate` and fails if anything in `docs-site/` changed. In other words, you must commit regenerated docs.
4. **Install the npm package and run it**: packs `@nouisi/keel` exactly as npm would, installs it into a temporary folder, and runs `keel --version`, creates a client, a project and a commitment against a throwaway database, and checks a backup was written.

**Core tests on file / libsql-server**: the core tests again, once on a database file and once against a real libSQL server started as a service container, including two synced copies talking through it. Bugs that only show up on a hosted database are caught here.

CI never publishes anything and needs no secrets.

### 1.6 Release: what a `v*` tag starts

`.github/workflows/release.yml`, triggered by pushing any tag that starts with `v`:

1. Sets up Node 22 and npm 11.15 or newer (needed for `npm stage publish`).
2. `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
3. **Check the tag matches the package version**: tag `v0.4.0` needs `"version": "0.4.0"`, or the run stops.
4. **Pack**: `pnpm pack` makes `nouisi-keel-0.4.0.tgz`.
5. **Stage on npm**: `npm stage publish`. If that version is already on npm, the step skips instead of failing.
6. **Create the GitHub release**: titled with the tag, the `.tgz` attached, with the notes taken from `CHANGELOG.md`.

The workflow has exactly two permissions: `contents: write` (to create the GitHub release) and `id-token: write` (for trusted publishing).

### 1.7 The gate: trusted publishing plus staged approval

Two npm features make this release gated:

- **Trusted publishing (no token).** npm is set up to trust this repository's `release.yml`. When the workflow runs, GitHub gives it a short-lived identity token (that's what `id-token: write` is for), and npm accepts the upload because it comes from that workflow in that repository. No npm token is stored in GitHub secrets, so there's nothing to leak or rotate. This is configured on npmjs.com, under the package's settings ("Trusted publisher").
- **Staged publishing (a human gate).** `npm stage publish` uploads the version as *staged*: it's on npm, but not installable and not `latest`. A maintainer has to approve it on npmjs.com, which asks for their 2FA code. Only then does it become installable and `latest`.

So even if a bad commit gets tagged, or someone pushes a tag they shouldn't, nothing reaches users without a person approving it with 2FA. If you see a `0.0.0-stage` version in npm's list, it's from testing this setup, before 0.1.0.

### 1.8 Docs site

`docs-site/` is a Mintlify project; `pnpm docs:dev` previews it locally.
- **Generated pages:** `reference/commands.mdx` (from each command's usage and the examples in `docs-site/scripts/generate.ts`) and `changelog.mdx` (from `CHANGELOG.md`). `pnpm docs:generate` rebuilds them, and CI fails if you forgot.
- **Deploys** happen through Mintlify's GitHub connection, not through these workflows. The "staging - docs-site" environment listed in the repository records Mintlify's deployments.

### 1.9 The Claude Code plugin: a second delivery channel

The plugin doesn't go through npm at all. The repository itself is a plugin marketplace (`.claude-plugin/marketplace.json` points to `plugins/claude`), so:
- users install it with `/plugin marketplace add upadhyayprakash/keel` and `/plugin install keel@keel`;
- it's served from `main` **as soon as you push**, with no tag or approval involved;
- users pick up changes with `/plugin marketplace update keel`;
- bump `version` in `plugins/claude/.claude-plugin/plugin.json` when its skills change;
- check it with `claude plugin validate .` from the repo root.

The plugin calls whatever `keel` the user has installed. A plugin change that relies on a new Keel feature should say which Keel version it needs.

## Part 2. SOP: make a change

### 2.1 First-time setup

```bash
git clone https://github.com/upadhyayprakash/keel.git
cd keel
corepack enable            # gives you the pinned pnpm
pnpm install
pnpm test && pnpm typecheck
pnpm keel today            # runs the CLI from source
```

**Test on throwaway data, never your real data.** Running from source uses your real `~/.keel` database (and your synced hosted copy, if you set one up). For experiments:

```bash
KEEL_HOME=$(mktemp -d) pnpm keel today      # an empty, throwaway Keel
```

### 2.2 Steps

1. **Start from an up-to-date `main` on a new branch.**
   ```bash
   git switch main && git pull
   git switch -c fix/show-year
   ```
2. **Make the change, with a test.** Core behaviour is tested in `packages/core/test/`. Run `pnpm test` and `pnpm typecheck` as you go.
3. **Docs**, if users will notice:
   - a line under `## [Unreleased]` in `CHANGELOG.md`;
   - for a new or changed command, its examples in `docs-site/scripts/generate.ts`, then `pnpm docs:generate`;
   - the hand-written docs pages (`docs-site/*.mdx`) where the behaviour is explained.
4. **Commit** with a [Conventional Commits](https://www.conventionalcommits.org/) message: `feat:`, `fix:`, `docs:`, `test:`, `chore:` or `release:`. Commit only the files that belong to this change:
   ```bash
   git commit -m "fix: show the year on dates outside the current year" -- packages/core/src/dates.ts packages/core/test/dates.test.ts
   ```
   The `--` followed by paths commits just those paths and leaves everything else as it is (useful when you have unrelated work in progress).
5. **Get it onto `main`**, one of two ways:
   - **Pull request** (for contributors, and recommended for bigger changes): `git push -u origin fix/show-year`, open a PR, follow the checklist in the PR template, wait for CI to go green, then merge.
   - **Direct** (a maintainer, for small changes): `git switch main && git merge --ff-only fix/show-year && git push`. `--ff-only` refuses unless it's a clean fast-forward.
6. **Watch CI on `main`:** `gh run list --limit 3`, or the repository's Actions tab. Fix anything red with a new commit before releasing.

Merged changes wait on `main` under `## [Unreleased]` until the next release. You don't have to release after every change.

## Part 3. SOP: release a version

Copy this checklist into your notes for each release.

- [ ] `main` is green in CI and has everything this release should contain
- [ ] Version chosen: MINOR for features, PATCH for fixes only
- [ ] Release commit prepared (3.2) and checks pass locally
- [ ] Release commit on `main` and pushed; CI green
- [ ] Tag created **and pushed**; `git ls-remote --tags origin vX.Y.Z` shows it
- [ ] Release workflow green; GitHub release exists
- [ ] Approved on npmjs.com
- [ ] Installed and checked locally (Part 4)

### 3.1 Prepare a clean copy (recommended)

Build the release from exactly what's committed, not from your working folder. A **worktree** is a second folder on another branch of the same repository, so your unfinished work stays untouched:

```bash
git fetch origin
git worktree add -b release/0.4.0 ../keel-release origin/main
cd ../keel-release
pnpm install --frozen-lockfile
```

### 3.2 Make the release commit

1. **CHANGELOG.md**: add the version heading right under Unreleased, so the existing notes now belong to it and Unreleased is empty:
   ```markdown
   ## [Unreleased]

   ## [0.4.0] - 2026-10-17

   ### Added
   - ...
   ```
   At the bottom, update the compare links:
   ```markdown
   [Unreleased]: https://github.com/upadhyayprakash/keel/compare/v0.4.0...HEAD
   [0.4.0]: https://github.com/upadhyayprakash/keel/compare/v0.3.1...v0.4.0
   ```
   Read the notes as a user would: the GitHub release shows them word for word.
2. **The version, in both places**: `apps/cli/package.json` and `packages/core/src/version.ts`.
3. **Regenerate the docs**: `pnpm docs:generate`. The docs changelog page picks up the new section.
4. **Run what the Release workflow will run**:
   ```bash
   pnpm typecheck && pnpm test && pnpm build
   node apps/cli/dist/keel.js --version                                     # the new version
   KEEL_HOME=$(mktemp -d) node apps/cli/dist/keel.js owe test @me due:fri    # a quick smoke test
   ```
5. **Commit**:
   ```bash
   git commit -m "release: 0.4.0, <one-line summary>" -- CHANGELOG.md apps/cli/package.json packages/core/src/version.ts docs-site/changelog.mdx
   ```

### 3.3 Put it on `main`

From your main repository folder (not the worktree):

```bash
git fetch . release/0.4.0:main     # fast-forward main to the release commit, without checking it out
git push origin main
gh run watch                        # wait for CI to pass
```

`git fetch . A:B` means "fast-forward branch B to A, inside this repository". It refuses if that isn't a clean fast-forward, so it can't lose commits. If you're on `main` already, `git merge --ff-only release/0.4.0` does the same.

### 3.4 Tag and push the tag

```bash
git tag v0.4.0 main
git push origin v0.4.0
git ls-remote --tags origin v0.4.0  # must print a line; if it doesn't, the tag isn't on GitHub
```

Run these as two separate commands, not joined with `&&`. If `git tag` fails because the tag already exists, a joined push silently never happens (see Part 6).

### 3.5 Watch the Release workflow

```bash
gh run list --workflow Release --limit 1
gh run watch
gh release view v0.4.0              # the GitHub release with the notes and the .tgz
```

### 3.6 Approve on npm (the gate)

1. Sign in to npmjs.com and open `@nouisi/keel`.
2. Find the staged version (0.4.0) and approve it. npm asks for your 2FA code.
3. Check: `npm view @nouisi/keel dist-tags` shows `latest: '0.4.0'`.

Until you approve, the version is visible to you but nobody can install it.

## Part 4. SOP: after the release

1. **Update your own machine:**
   ```bash
   npm install -g @nouisi/keel@0.4.0
   keel --version
   ```
   Your data needs nothing: database changes, if any, run automatically on first use, and a daily backup is in `~/.keel/backups`. If you use Keel on several devices, update each one.
2. **Try one thing the release changed**, on real use. For 0.4.0: `keel show c8` reads "for myself" with a full date.
3. **Clean up the worktree:**
   ```bash
   git worktree remove ../keel-release
   git branch -d release/0.4.0
   ```
4. **Bring your feature branches up to date** when you next work on them: `git switch <branch> && git merge main`.
5. **Plugin users** (if the plugin changed): mention `/plugin marketplace update keel` in the release notes or announcement.

## Part 5. When something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `fatal: tag 'v0.4.0' already exists` | The tag was created earlier | Check it's on the release commit: `git log -1 --oneline v0.4.0`. If it is, just `git push origin v0.4.0` |
| Nothing staged on npm | The tag isn't on GitHub, or the Release run failed | `git ls-remote --tags origin v0.4.0`, then `gh run list --workflow Release` |
| Release stops at "Check the tag matches the package version" | The tagged commit doesn't have the version bump | Delete the tag (below), fix, tag the right commit |
| CI fails at "Docs site matches the code" | `pnpm docs:generate` not run, or its output not committed | Run it, commit `docs-site/`, push |
| A test fails saying the versions differ | `package.json` and `version.ts` don't match | Make them match |
| `pnpm install --frozen-lockfile` fails | A `package.json` changed without updating `pnpm-lock.yaml` | Run `pnpm install` locally and commit the lockfile |
| `git fetch . release/X:main` is rejected | `main` has commits the release branch doesn't | `git switch release/X && git rebase main`, rerun the checks, try again |
| Release log says "already on npm, skipping publish" | That version number is taken on npm | Release the next version |

**Undoing a tag:**

| Situation | What to do |
|---|---|
| Tag made, **not pushed** | `git tag -d v0.4.0`, then tag the right commit |
| Tag pushed, version **staged but not approved** | Reject the staged version on npmjs.com, then `git push origin :refs/tags/v0.4.0`, `git tag -d v0.4.0`, `gh release delete v0.4.0`; fix and tag again |
| Version **approved** on npm | npm versions can never be replaced. Don't move the tag. Fix forward with 0.4.1 |

Rule of thumb: until you approve on npm, every step can be undone. After approval, only move forward.

## Part 6. Worked example: 0.4.0

What went in: a Claude Code plugin, `@me` for promises to yourself, and years shown on dates outside the current year.

| # | Step | Commands and result |
|---|---|---|
| 1 | Change | Three commits: `feat: Claude Code plugin for Keel`, `fix: show the year on dates outside the current year`, `feat: @me for promises to yourself`. Each was committed with `-- <paths>`, because the working folder also held unfinished passkey work that had to stay out |
| 2 | Clean copy | `git worktree add -b release/0.4.0 <folder> <last commit>`; `pnpm install --frozen-lockfile` |
| 3 | Release commit | MINOR bump (new features), so 0.4.0. CHANGELOG moved under `## [0.4.0] - 2026-10-17` with links; version in both files; `pnpm docs:generate`; typecheck, 101 tests, build and a smoke test passed. Commit `fd7a96a release: 0.4.0, @me, years on dates and the Claude Code plugin` |
| 4 | Main | `git fetch . release/0.4.0:main`, `git push origin main`. CI passed in 51 s. This also published one earlier unpushed commit on `main` (an ADR) |
| 5 | Tag | `git tag v0.4.0 main && git push origin v0.4.0` printed `fatal: tag 'v0.4.0' already exists`. The tag had been created by an earlier attempt, so `git tag` failed and `&&` skipped the push. The tag existed only locally: `git ls-remote --tags origin v0.4.0` printed nothing, the Release workflow never started, and nothing was staged on npm |
| 6 | Fix | `git push origin v0.4.0`. Release ran in 53 s: checks passed, 0.4.0 staged on npm, GitHub release v0.4.0 created |
| 7 | Gate | Approve 0.4.0 on npmjs.com with 2FA. Until then `npm view @nouisi/keel dist-tags` still says `latest: 0.3.1` |
| 8 | Local | `npm install -g @nouisi/keel@0.4.0`; `keel --version` |

Lesson: push the tag as its own command, and confirm with `git ls-remote --tags`.

## Part 7. Not set up yet

As of 0.4.0, the repository has **no branch protection and no rulesets**. Anyone with write access can push straight to `main` or push a `v*` tag; the npm approval gate is what stops a bad release reaching users. Worth adding as more people contribute:

- **A ruleset on `main`**: require a pull request and the two CI jobs to pass before merging; block force pushes.
- **A tag ruleset on `v*`**: only maintainers can create or delete release tags.
- **A GitHub environment for the release job**, with required reviewers: a second, GitHub-side approval before staging. This one is optional, since npm's approval already gates the release.

When one of these is turned on, update this section and Part 2.

## Cheat sheet

```bash
# develop
git switch main && git pull && git switch -c fix/thing
pnpm test && pnpm typecheck
KEEL_HOME=$(mktemp -d) pnpm keel today                      # throwaway data
git commit -m "fix: ..." -- <paths>
git switch main && git merge --ff-only fix/thing && git push    # or open a PR

# release X.Y.Z
git fetch origin && git worktree add -b release/X.Y.Z ../keel-release origin/main
cd ../keel-release && pnpm install --frozen-lockfile
#   CHANGELOG.md: heading + links; apps/cli/package.json and packages/core/src/version.ts: version
pnpm docs:generate && pnpm typecheck && pnpm test && pnpm build
git commit -m "release: X.Y.Z, <summary>" -- CHANGELOG.md apps/cli/package.json packages/core/src/version.ts docs-site/changelog.mdx
cd -                                                         # back to the main repo folder
git fetch . release/X.Y.Z:main && git push origin main     # wait for CI
git tag vX.Y.Z main
git push origin vX.Y.Z
git ls-remote --tags origin vX.Y.Z && gh run watch
#   approve on npmjs.com (2FA)
npm view @nouisi/keel dist-tags
npm install -g @nouisi/keel@X.Y.Z && keel --version
git worktree remove ../keel-release && git branch -d release/X.Y.Z
```
