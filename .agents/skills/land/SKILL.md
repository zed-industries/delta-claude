---
name: land
description: Git flow for landing a change on the delta-claude repo's main branch.
disable-model-invocation: true
metadata:
  delta-action: land
---

# Landing changes

## Permission gate

Never modify `main` without the user's explicit, direct permission to land the
specific change. This covers every way of changing `main`: `gh pr merge`,
auto-merge, a direct push to `refs/heads/main`, or any API call that updates it.

A request to implement, push a branch, open a pull request, or check CI is not
permission, and neither are green checks. Permission is explicit when the user
asks to merge or land the identified change, including “land it when CI
passes.” If the change materially changes after permission was given, ask again
before landing.

## 1. Prepare the commit

- A change people will notice gets an entry in `release-notes/`, named
  `YYYY-MM-DD-<topic>.md` with a `category:` of `Added`, `Improved`, or `Fixed`,
  like the existing entries.
- A change installed plugins should pick up bumps `version` in
  `.claude-plugin/plugin.json`.
- Rebase onto current `origin/main` and squash to a single commit. CI tests the
  branch head only, so every commit that reaches `main` must be one CI tested.

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

## 3. Put the tested commit on `main`

Reconfirm permission, confirm `CI Pass` succeeded on that exact commit, then push
it:

```sh
gh api repos/zed-industries/delta-claude/commits/"$sha"/status \
  --jq '.statuses[] | select(.context == "CI Pass") | .state'
git push origin "$sha:refs/heads/main"
```

This needs organization membership. Without it the push is rejected; open a
pull request for the branch instead and squash-merge it once `CI Pass` is green.

If `main` has moved, the push is rejected as non-fast-forward. Rebase onto the new
`origin/main`, push the branch, wait for CI on the rebased commit, and push that
one. Never push a commit to `main` that CI has not passed.

## 4. Clean up

```sh
branch=$(git branch --show-current)
git push origin --delete "$branch"
git switch main
git pull --ff-only origin main
git branch -d "$branch"
```

If a cleanup step fails, report it rather than forcing it; the change has
already landed.
