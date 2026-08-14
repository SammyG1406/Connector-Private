"""Basic text chunking for RAG pipelines."""

import argparse


def chunk_text(text, chunk_size=500, overlap=50):
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    if overlap < 0 or overlap >= chunk_size:
        raise ValueError("overlap must be non-negative and smaller than chunk_size")

    chunks = []
    start = 0
    text_length = len(text)
    while start < text_length:
        end = min(start + chunk_size, text_length)
        chunks.append(text[start:end])
        if end == text_length:
            break
        start = end - overlap
    return chunks


def main():
    parser = argparse.ArgumentParser(description="Chunk a text file for RAG ingestion.")
    parser.add_argument("file", help="Path to the input text file")
    parser.add_argument("--chunk-size", type=int, default=500, help="Characters per chunk")
    parser.add_argument("--overlap", type=int, default=50, help="Character overlap between chunks")
    args = parser.parse_args()

    with open(args.file, "r", encoding="utf-8") as f:
        text = f.read()

    chunks = chunk_text(text, args.chunk_size, args.overlap)
    for i, chunk in enumerate(chunks):
        print(f"--- chunk {i} ({len(chunk)} chars) ---")
        print(chunk)


if __name__ == "__main__":
    main()
