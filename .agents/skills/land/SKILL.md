---
name: land
description: Git flow for landing a change on the delta-claude repo's develop branch and releasing develop to main.
disable-model-invocation: true
metadata:
  delta-action: land
---

# Landing and releasing changes

The repo has two long-lived branches:

- `develop` is trunk. Every change lands here first. Installs that added the marketplace as
  `zed-industries/delta-claude#develop` update from it.
- `main` is stable. It is the default branch, so every install that added the marketplace as
  `zed-industries/delta-claude` updates from it. It only ever moves to a commit that is already on
  `develop`, except for a hotfix.

Claude Code has no release channels of its own: each install follows whichever branch its
marketplace was added from, and updates only when `version` in `.claude-plugin/plugin.json` changes.

## Permission gate

Never modify `develop` or `main` without the user's explicit, direct permission. This covers every
way of changing either branch: `gh pr merge`, auto-merge, a direct push, or any API call that
updates it.

Landing and releasing are separate permissions. Permission to land a change on `develop` is not
permission to release it to `main`, and permission to release names the `develop` commit to
release.

A request to implement, push a branch, open a pull request, or check CI is not permission, and
neither are green checks. Permission is explicit when the user asks to land, merge, or release the
identified change, including “land it when CI passes.” If the change materially changes after
permission was given, ask again before landing.

## 1. Prepare the commit

- A change people will notice gets an entry in `release-notes/`, named
  `YYYY-MM-DD-<topic>.md` with a `category:` of `Added`, `Improved`, or `Fixed`,
  like the existing entries.
- A change installed plugins should pick up bumps `version` in
  `.claude-plugin/plugin.json`. A version names exactly one tree: take a number above every
  version either branch has used, never one a different commit already carries.
- Rebase onto current `origin/develop` and squash to a single commit. CI tests the
  branch head only, so every commit that reaches `develop` must be one CI tested.

The commit message is the change's only description. After a short imperative
subject, write a few short paragraphs explaining the motivation, the previous
behavior, and how the change addresses it. Write it to a file and pass it with
`git commit -F`. When the thread is shared, end it with its share URL:

```
Delta-Thread: https://delta.dev/join/thread_...
```

## 2. Push the branch and wait for CI

CI runs on every branch push.

```sh
git push -u origin HEAD
sha=$(git rev-parse HEAD)
gh run list --workflow CI --commit "$sha" --event push --json databaseId,url
gh run watch <run-id> --exit-status
```

Give the participant the run URL. Fix small, unambiguous failures yourself and
push again. Stop and report a failure that looks like flakiness, is unrelated to
the change, or needs a product decision.

## 3. Put the tested commit on `develop`

Reconfirm permission, confirm `CI Pass` succeeded on that exact commit, then push
it:

```sh
gh api repos/zed-industries/delta-claude/commits/"$sha"/status \
  --jq '.statuses[] | select(.context == "CI Pass") | .state'
git push origin "$sha:refs/heads/develop"
```

This needs organization membership. Without it the push is rejected; open a
pull request against `develop` for the branch instead and squash-merge it once `CI Pass` is green.
GitHub proposes `main` as a pull request's base, so set the base to `develop`.

If `develop` has moved, the push is rejected as non-fast-forward. Rebase onto the new
`origin/develop`, push the branch, wait for CI on the rebased commit, and push that
one. Never push a commit to `develop` that CI has not passed.

## 4. Clean up

```sh
branch=$(git branch --show-current)
git push origin --delete "$branch"
git switch develop
git pull --ff-only origin develop
git branch -d "$branch"
```

If a cleanup step fails, report it rather than forcing it; the change has
already landed.

## Releasing `develop` to `main`

A release fast-forwards `main` to a `develop` commit. The commit keeps the `CI Pass` status it
earned on `develop`, so a release needs no new CI run and never creates a commit.

1. Pick the `develop` commit to release, usually the head of `origin/develop`, and get permission
   to release that commit.
2. Check that every Delta CLI build this release must work with can record with it, including
   the current stable build. The CLI's `thread contract` must report a `max` of at least
   `PLUGIN_CONTRACT_MIN` in `hooks/cli/thread-commands.ts` at that commit. Otherwise the plugin
   refuses to record with "This Delta is too old for this plugin". If it does not, hold the
   release until that CLI build ships.
3. Confirm `CI Pass` on the commit and that `main` fast-forwards to it, then push it:

   ```sh
   git fetch origin develop main
   sha=<develop commit>
   git merge-base --is-ancestor "$sha" origin/develop
   git merge-base --is-ancestor origin/main "$sha"
   gh api repos/zed-industries/delta-claude/commits/"$sha"/status \
     --jq '.statuses[] | select(.context == "CI Pass") | .state'
   git push origin "$sha:refs/heads/main"
   ```

If `main` does not fast-forward to the commit, a hotfix on `main` has not been merged back into
`develop` yet. Merge it back first, as described below.

## Hotfixing `main`

When stable needs a fix that cannot wait for `develop` to be releasable:

1. Branch from `origin/main` and make the fix as in steps 1 and 2, bumping `version` above every
   version either branch has used.
2. With permission to hotfix `main`, push the tested commit to `main` as in step 3, with
   `main` in place of `develop`.
3. Merge `origin/main` into a branch from `origin/develop` with a merge commit, not a rebase or
   cherry-pick, so the next release still fast-forwards. Bump `version` again in the merge,
   since the merged tree differs from both parents. Push the branch, wait for CI, and land the
   merge commit on `develop` as in step 3. If `develop` has moved, redo the merge on the new
   `origin/develop` rather than rebasing it.
