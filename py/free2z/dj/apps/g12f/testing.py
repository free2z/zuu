"""Test helpers for g12f tasks. Imported only by tests.

`g12f.notify_published_zpage` is declared `pass_context=True`, so the worker
calls it as `task(context, **args)` and the repo's convention of exercising a
task by calling the plain function needs a stand-in for the one attribute the
task reads: `context.job.id`, which is the identity of the broadcast (see
`g12f.publication.page_update_dedup_key`).

A `SimpleNamespace` rather than a real `procrastinate.job_context.JobContext`
on purpose: constructing the real one needs an `App`, a `Job`, a start
timestamp and an abort callback, none of which the task touches, and every
one of which would have to be updated on a procrastinate bump for no gain.
The thing worth pinning is that the task reads `.job.id` and nothing else --
`test_page_update_outbox.py` asserts on the key that comes out of it.
"""
from types import SimpleNamespace


def job_context(job_id: int) -> SimpleNamespace:
    """A stand-in for the `JobContext` a procrastinate worker passes."""
    return SimpleNamespace(job=SimpleNamespace(id=job_id))
