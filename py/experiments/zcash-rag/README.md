# Zcash RAG experiment

Legacy experiment indexing the Zebra codebase and ZIPs. This is not a supported
SDK or application. Its historical dependency snapshot has not been revalidated
against current providers; review and restore it before running.

## Pre-requisites

- You should have python3 installed.
- To use the OPENAI API, you need to set the OPENAI_API_KEY environment variable.
- To use langsmith, you need to set the LANGCHAIN_API_KEY environment variable.

## Setup

Run setup from `py/experiments/zcash-rag/`:

```sh
python3 -m venv env
source env/bin/activate
pip install -r requirements.txt
```

## Run

You can run the python notebooks for interactive experiments.

```sh
# SET OPENAI_API_KEY and LANGCHAIN_API_KEY if you like
cd notebooks
jupyter notebook
```

From `py/experiments/zcash-rag/` (return there after launching the notebook),
the script entrypoint is:

```sh
python rag_chain.py
```

The RAG chain will take a while on the first run because it loads and
indexes the documents. Subsequent runs will be faster. The script drops
you into an IPython shell where you can ask questions. For example:

```python
chat("How do we use orchard/HALO to increase the Transactions Per Second theoretical maximum of Zcash?")
```

Look at the `rag_chain.py` to see what other variables you have access to.
You can clear the memory of the chat by running `memory.clear()`.

The scripts expect this directory as their working directory and read the
`z/ZcashFoundation/zebra` and `z/zcash/zips` submodules at the repository root.
Initialize those corpora before indexing. Notebook corpus paths are relative to
`notebooks/`. Indexing and questions can incur provider charges.
