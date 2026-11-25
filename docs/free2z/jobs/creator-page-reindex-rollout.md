# Creator page reindex rollout

## Release 1: register only

This release registers `g12f.reindex_creator_pages` and its reclaim policy.
The task processes stable primary-key batches and carries the creator account
epoch in every continuation. Each batch locks the creator row while validating
the epoch and deletion state. It does not have a producer yet; `keep_account`
continues using its existing bounded post-commit reindex behavior.

The task is classified `NEVER` for automatic reclaim. Its downstream search
jobs can make paid OpenAI calls, so replaying a batch can repeat charges. The
database and queue operations also have no enforced whole-task deadline. This
release does not claim exactly-once indexing, deduplicated paid calls, or
bounded retry cost. A later release needs durable batch progress and a reviewed
paid-work retry budget before enabling automatic recovery or the keep producer.

## Release 2: enable the producer

In a separate release, change `keep_account` to transactionally defer the new
task with the creator ID and current `kt_account_epoch`, and remove the legacy
`KEEP_REINDEX_LIMIT` producer path. Verify every published page is reached
across continuation jobs, and retain the account visibility and epoch checks.
That producer release must also decide how partial batch failures recover
without unbounded repeat charges. Until the producer and recovery work ship,
this is only the register phase of #1305; the truncation metric and bounded
renewal rearm remain unresolved.
