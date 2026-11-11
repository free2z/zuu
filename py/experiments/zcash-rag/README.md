# Zcash RAG experiment (legacy)

This directory preserves the historical retrieval experiment source and
notebook for reference. It has no supported installable environment, CI job,
deployment, or shipping application consumer. The old dependency snapshot was
removed because it was unmaintained and exposed an obsolete dependency graph;
the source and notebook remain available but are not currently supported for
execution.

`store.py` documents the experiment's former ingestion inputs: the
`z/ZcashFoundation/zebra` and `z/zcash/zips` submodules. The notebook's corpus
paths are relative to `notebooks/`. Reinstating execution would require a
separately reviewed, compatible dependency environment and ingestion/query
checks. Its former OpenAI and LangSmith integrations may incur provider charges
if restored and used.
