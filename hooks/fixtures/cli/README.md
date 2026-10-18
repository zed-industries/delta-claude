# CLI JSON fixtures

These are native CLI output examples, rendered by production builders and checked
byte-for-byte, including the trailing newline. Host integration checks normalize
only generated identities and absolute caller paths.

| Files | Examples and checks |
| --- | --- |
| `thread-status.{local_only,granted,worktrees_unavailable}.json` | Producer status, nullable current title, access and inventory availability, and last known audience (`visibility`) and upload progress (`upload`); `delta_ipc::cli_output::tests::recording_outputs_match_cli_fixtures`. |
| `thread-append.{recorded,fenced,duplicate}.json`, `thread-append.batch.jsonl` | Append dispositions, nullable turn sequence and ordered receipts; the same builder test. |
| `thread-create.json`, `thread-share.json`, `thread-invite.json` | Creation, sharing, and invitation receipts; the same builder test. |
| `thread-contract.json` | The recording-output contract versions this build speaks; the same builder test. |
| `thread-watch.frames.jsonl` | Ready without/with producer, item, item.append, remove, live, idle turn, running turn, running turn without an ID, producer.turn, presence, worktrees, terminal error, comments, children, child, child.remove. The first 12 lines are checked by `delta_ipc::cli_output::tests::subscription_frames_match_cli_fixtures`; the terminal line by `delta`'s `every_error_envelope_says_whether_the_same_request_may_succeed_later`, through `report_failure`; comment and child examples by their builder tests. These are frame examples, not one causally valid session. |
| `thread-{mount,unmount}.json` | External owner and mounted paths; `thread_mounts_name_their_owner_and_report_mounted_paths`. |
| `worktree-attach.json` | The mounted receipt accepted by attach; `worktree_attach_dispatches_and_accepts_the_mounted_receipt`. |
| `worktree-{create,mount,unmount}.json` | Ordinary receipts; `worktree_results_have_scriptable_output_and_typed_failures`. |
| `worktree-list.json`, `worktree-unmount.detached.json` | Local reference, waiting state, owners and detach metadata; `local_handles_and_waiting_messages_survive_cli_ipc_and_rendering`. |
| `error-codes.json` | The failure codes recording commands publish, each with `retryable` where every cause agrees; an empty object means retryability varies by cause. `every_error_envelope_says_whether_the_same_request_may_succeed_later` iterates the thread, worktree and authentication failure enums, plus general CLI failures, renders real envelopes in both the published and the specific form, and requires every published code to have a cause. The specific codes, which recording commands carry as a diagnostic `reason`, and messages are intentionally not pinned by this table. |

Recording host integration tests also compare status, readiness and turn/presence
output against these examples, retaining their behavioral assertions.

Children examples include opaque `reference` command targets alongside identity-only
`thread_id` values. The selector path example represents an attached agent beneath
an independent descendant. Fixture IDs are illustrative; native host tests capture
real watch references and reconnect with cache-empty clients.

The mount fixture's top-level `directory` is the session's working directory.
With `thread mount --folder`, it is a plain thread folder even for a single
worktree; each worktree's `directory` still points to its checkout. The result
shape is unchanged.

Status objects always include `title`: the thread's current display name as a
string, or `null` when unnamed. This is the loaded thread's name, not a cached
catalog name. The local-only and granted fixtures show named threads; the
unavailable-worktrees fixture shows an unnamed thread.

From the repository root, regenerate in this order:

```sh
DELTA_UPDATE_CLI_FIXTURES=1 corgi test -p delta_ipc --lib
DELTA_UPDATE_CLI_FIXTURES=1 corgi test -p delta --bin delta 'tests::(thread_mounts_name|worktree_attach_dispatches|worktree_results_have|local_handles_and_waiting|every_error_envelope)'
```

Repeat without `DELTA_UPDATE_CLI_FIXTURES` to check rather than update. Review all
fixture changes: regeneration is not approval of an output-contract change.
If Corgi is unavailable, use `cargo test` with individual test names (Cargo uses
substring filters, not regular expressions).

The Claude Code plugin keeps a copy refreshed by its `scripts/sync-cli-fixtures`.
Refresh that copy after approved native changes; do not maintain different
hand-written JSON contracts in the mock.
