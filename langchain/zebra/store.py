from langchain_community.document_loaders.generic import GenericLoader
from langchain_community.document_loaders.parsers import LanguageParser
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import Chroma
from langchain_openai import OpenAIEmbeddings


def get_retriever(persist_directory="./chroma/openai", k=20):
    # Attempt to initialize Chroma from the persist directory
    # If this directory exists and has data, this will load the data
    vectorstore = Chroma(persist_directory=persist_directory, embedding_function=OpenAIEmbeddings())
    # print("Loaded Chroma store from disk.")
    # print("Embeddings:", vectorstore.embeddings)
    # import IPython; IPython.embed()
    if not vectorstore._collection.count():
        # If the directory doesn't exist or is empty, we'll create and save the data
        print(f"Creating a new Chroma store.")

        # Load your documents using the GenericLoader
        loader = GenericLoader.from_filesystem(
            "../../z/ZcashFoundation/zebra/",
            glob="**/*",
            suffixes=[".rs", ".toml", ".yaml", ".md", ".json", ".proto"],
            parser=LanguageParser(),
        )
        zebra_docs = loader.load()

        zips_loader = GenericLoader.from_filesystem(
            "../../z/zcash/zips/",
            glob="**/*",
            suffixes=[".rst"],
            parser=LanguageParser(),
        )
        zip_docs = zips_loader.load()

        docs = zebra_docs + zip_docs

        # Split your documents into smaller chunks
        # text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        # default is 4000 with 200 overlap
        text_splitter = RecursiveCharacterTextSplitter()
        splits = text_splitter.split_documents(docs)

        # Create the vector store and save it to the specified directory
        vectorstore = Chroma.from_documents(documents=splits, embedding=OpenAIEmbeddings(), persist_directory=persist_directory)
        vectorstore.persist()
        print("Indexed documents and saved Chroma store to disk.")

    else:
        print(f"Loaded Chroma store from disk with {vectorstore._collection.count()} documents.")

    # print(vectorstore.embeddings)

    # Return the vectorstore as a retriever
    return vectorstore.as_retriever(
        search_kwargs={'k': k}
    )
