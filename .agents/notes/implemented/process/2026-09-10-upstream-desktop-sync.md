# Agent Note: Automated upstream desktop sync

Status: implemented

English | [中文](2026-09-10-upstream-desktop-sync.zh.md)

## Problem

This repository is a full copy of `deepseek-ai/deepseek-harness` plus Electron packaging under `apps/desktop`, `apps/desktop-host`, and desktop GitHub Actions. It is not a GitHub fork, so it does not receive upstream `dsh-v*` tags automatically, and its Git history does not share a merge-base with upstream. Unsigned desktop GitHub Releases already start from a `desktop-v*` tag via [desktop-release.yml](../../../../.github/workflows/desktop-release.yml). Maintainers otherwise have to import each upstream tag by hand and remember not to publish a Release from a conflicted tree.

## Decision

[upstream-desktop-sync.yml](../../../../.github/workflows/upstream-desktop-sync.yml) runs every six hours and on `workflow_dispatch`. It selects the newest upstream `dsh-v*` tag, or the tag named by the dispatch input. [upstream-desktop-sync.ts](../../../../scripts/upstream-desktop-sync.ts) skips the run when origin already has `desktop-v{same-semver-suffix}` or the default branch already records `Upstream-Tag: dsh-v…` for that version.

The import uses `git merge-tree --write-tree` with an explicit merge-base: the most recent imported upstream tag still resolvable in this repository, otherwise this repository's root commit. That ancestor is required because the two histories are unrelated. After applying the result tree, the script checks out the overlay allowlist from HEAD and reinserts missing root `package.json` desktop script keys. Overlay paths are the unsigned-release workflows, this sync workflow, generated desktop icons, local menu fixtures, this sync script, and the GitHub Release installer uploader. `apps/desktop/**` as a whole is not overlay: upstream owns the Electron shell, so those files take a normal three-way merge.

When the only conflicts were overlay paths, the script fast-forwards the default branch and pushes annotated `desktop-v*`. That tag is the existing Desktop release trigger; this workflow does not package Electron. After the tag push it lists `desktop-release.yml` runs for that tag and dispatches the workflow on the tag ref when none started, so a `GITHUB_TOKEN` push still packages. When any non-overlay path conflicts, the script may call Anthropic (`ANTHROPIC_API_KEY`, preferred) or OpenAI (`OPENAI_API_KEY`) to edit remaining conflict markers, then opens a draft pull request and does not tag or dispatch. AI success does not change that rule.

`DESKTOP_SYNC_TOKEN` or `GH_PAT` should be a PAT with contents, pull requests, workflow, and actions scopes. A PAT with workflow scope usually starts Desktop release from the tag push; dispatch is the fallback when no matching run appears. After a human merges a conflict pull request, they push `desktop-v*` themselves to publish.

## Alternatives considered

**Turn this repository into a GitHub fork and rebase onto upstream.** GitHub fork sync would follow upstream history, but this copy already has an unrelated root commit and desktop-only tags. Rebuilding it as a fork would rewrite every existing `desktop-v*` object and the current GitHub Release URL space.

**Open a pull request for every import, including clean merges.** That adds a human delay to every upstream release. Clean three-way results plus overlay restore are deterministic, so they may fast-forward and tag. Conflicted and AI-resolved trees still stop at a pull request.

**Treat all of `apps/desktop/**` as ours.** Upstream ships the same Electron packaging tree. Keeping ours on every desktop path would drop upstream shell and seed fixes. The overlay allowlist is the set of files that exist only in this copy or that this copy must keep for unsigned Releases.

**Add a second Electron packaging workflow instead of pushing `desktop-v*`.** [desktop-release.yml](../../../../.github/workflows/desktop-release.yml) already builds macOS arm64 and Windows x64 unsigned artifacts. A parallel publisher would drift from that path.

**Dispatch Desktop release on every clean tag without listing existing runs.** A PAT with workflow scope already starts packaging from the tag push. Unconditional dispatch would run that workflow twice. Listing first, then dispatching only when no run targets the tag, covers a `GITHUB_TOKEN` push without doubling PAT runs.

## Consequences

Scheduled imports can publish a GitHub Release without a human when the merge is clean. Conflicted imports cannot. Overlay files listed in [upstream-desktop-sync.ts](../../../../scripts/upstream-desktop-sync.ts) survive upstream deletions; other files that exist only in an old snapshot of this copy follow upstream and may disappear. Operators who merge a conflict pull request must push `desktop-v*` before testers see installers.
