Experiment to RAG the entire zebrad codebase.

## Pre-requisites

- You should have python3 installed.
- To use the OPENAI API, you need to set the OPENAI_API_KEY environment variable.

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
