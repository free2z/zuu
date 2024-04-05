import os
# from operator import itemgetter

from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain.memory import ConversationBufferMemory
from langchain.chains import ConversationChain
from langchain_core.runnables import RunnablePassthrough

from store import get_retriever
from rag_fusion import reciprocal_rank_fusion, generate_queries

if 'LANGCHAIN_API_KEY' in os.environ:
    os.environ['LANGCHAIN_TRACING_V2'] = 'true'
    os.environ['LANGCHAIN_ENDPOINT'] = 'https://api.smith.langchain.com'

template = """
You are and expert software developer who knows everything about
the Zebra project from the Zcash foundation. You teach new developers
about the project in detail.

Use the history and the context to respond to the prompt.

History:

{history}

Context:

{context}

Prompt:

{user_prompt}
"""
prompt = ChatPromptTemplate.from_template(template)

llm4 = ChatOpenAI(
    # model_name="gpt-3.5-turbo",
    model_name="gpt-4-turbo-preview",
    temperature=0,
    streaming=True,
)
llm35 = ChatOpenAI(
    model_name="gpt-3.5-turbo",
    temperature=0,
)

memory = ConversationBufferMemory()

summarize_template = """
Summarize the following conversation history while maintaining
all of the important vocabulary:
{context}
"""
summarize_prompt = ChatPromptTemplate.from_template(summarize_template)


# def format_docs(docs):
#     """join the splits into a single string"""
#     return "\n\n".join(doc.page_content for doc in docs)


def format_full_docs(docs):
    """
    Join the full documents into a single string.

    We could do a fancier indexing here (hierarchical?),
    but for now we'll just join the full contents.
    """
    # Collect unique source file paths
    sources = set()

    # Prepare to collect content from each file
    full_contents = []

    for doc in docs:
        if doc.metadata['source'] in sources:
            continue

        source = doc.metadata['source']
        full_contents.append(f"Source: {source}")

        # Check if the file is not too large to process
        # This threshold is arbitrary and can be adjusted based on your needs
        # Limit to files under 20KB
        if os.path.getsize(source) < 20 * 1024:
            try:
                with open(source, 'r', encoding='utf-8') as file:
                    # Read the entire file content
                    content = file.read()
                    # Append the content to the list, possibly with additional formatting
                    full_contents.append(content)
                    sources.add(source)
            except Exception as e:
                print(f"Error reading {source}: {e}")
        # Otherwise, just append the split content
        else:
            full_contents.append(doc.page_content)

    # Join all contents into a single string, separated by double newlines
    return "\n\n".join(full_contents)


class MemoryLoaderRunnable:
    def __init__(self, memory):
        self.memory = memory

    def __call__(self, input):
        history = self.memory.load_memory_variables({}).get("history", "")
        if not history:
            return ""
        summary = {"context": RunnablePassthrough()} | summarize_prompt | llm35 | StrOutputParser()
        return summary.invoke(history)


def get_ai(retriever):

    # retrieval_chain_rag_fusion = generate_queries | retriever.map() | reciprocal_rank_fusion
    # docs = retrieval_chain_rag_fusion.invoke({"question": question})
    # print(docs)

    memory_loader_runnable = MemoryLoaderRunnable(memory)

    ai = (
        {
            # "context": retrieval_chain_rag_fusion,
            # "context": itemgetter("question") | retriever | format_docs,
            # "context": itemgetter("question") | retriever | format_full_docs,
            "history": memory_loader_runnable,
            "context": RunnablePassthrough() | retriever | format_full_docs,
            "user_prompt": RunnablePassthrough(),
        }
        | prompt
        | llm4
        | StrOutputParser()
    )

    def chat(user_prompt):
        words = []
        for s in ai.stream(user_prompt):
            print(s, end="", flush=True)
            words.append(s)
        memory.save_context({"input": user_prompt}, {"output": "".join(words)})

    return chat


if __name__ == "__main__":
    retriever = get_retriever(k=5)
    chat = get_ai(retriever)
    import IPython; IPython.embed()
