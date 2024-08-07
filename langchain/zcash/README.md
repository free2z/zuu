Experiment to RAG the entire zebrad codebase.

## Pre-requisites

- You should have python3 installed.
- To use the OPENAI API, you need to set the OPENAI_API_KEY environment variable.
- To use langsmith, you need to set the LANGCHAIN_API_KEY environment variable.

## Setup

```
python3 -m venv env
source env/bin/activate
pip install -r requirements.txt
```

## Run

You can run the python notebooks for interactive experiements.

```sh
# SET OPENAI_API_KEY and LANGCHAIN_API_KEY if you like
cd notebooks
jupyter notebook
```

To run the final RAG model, you can run the following command:

```sh
python zebra_chain.py
```

The zebra_chain will take a while on the first run because it loads and
indexes the documents. Subsequent runs will be faster. The script drops
you into an IPython shell where you can ask questions. For example:

```python
chat("How do we use orchard/HALO to increase the Transactions Per Second theoretical maximum of Zcash?")
```

Look at the `zebra_chain.py` to see what other variables you have access to.
You can clear the memory of the chat by running `memory.clear()`.
