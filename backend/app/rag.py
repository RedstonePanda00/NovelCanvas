from __future__ import annotations

import math
import uuid
from datetime import datetime, timezone

from .ai_provider import ProviderRequestError, create_embeddings
from .models import (
    CanvasNode,
    KnowledgeChunk,
    KnowledgeDocument,
    KnowledgeDocumentCreateResponse,
    KnowledgeIndex,
    KnowledgeIndexEntry,
    KnowledgeReindexResult,
    RagPreviewResponse,
    RagSnippet,
)
from .paths import KNOWLEDGE_DOCUMENTS_DIR
from .stores import (
    find_provider,
    find_registered_model,
    get_knowledge_chunk_map,
    read_knowledge_chunks,
    read_knowledge_index,
    read_knowledge_metadata,
    read_project,
    write_knowledge_chunks,
    write_knowledge_index,
    write_knowledge_metadata,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _chunk_text(text: str, max_chars: int = 1200, overlap_chars: int = 160) -> list[str]:
    clean = "\n".join(line.rstrip() for line in text.splitlines()).strip()
    if not clean:
        return []

    chunks: list[str] = []
    cursor = 0
    while cursor < len(clean):
        end = min(len(clean), cursor + max_chars)
        split_at = clean.rfind("\n\n", cursor, end)
        if split_at <= cursor:
            split_at = clean.rfind("\n", cursor, end)
        if split_at <= cursor:
            split_at = end

        chunk = clean[cursor:split_at].strip()
        if chunk:
            chunks.append(chunk)

        if split_at >= len(clean):
            break
        cursor = max(split_at - overlap_chars, cursor + 1)

    return chunks


def _cosine_similarity(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left or not right:
        return 0.0

    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if not left_norm or not right_norm:
        return 0.0

    return dot / (left_norm * right_norm)


def _embedding_model_config() -> tuple[str | None, str | None, str | None]:
    project = read_project()
    embedding_model_id = project.settings.modelRouting.embeddingModelId
    if not embedding_model_id:
        return None, None, "No embedding model is selected in project settings."

    registered_model = find_registered_model(embedding_model_id)
    if registered_model is None:
        return embedding_model_id, None, f"Embedding model is not registered: {embedding_model_id}"

    provider = find_provider(registered_model.providerId)
    if provider is None:
        return embedding_model_id, None, f"Provider is not registered: {registered_model.providerId}"

    return embedding_model_id, registered_model.modelId, None


async def _embed_texts(texts: list[str]) -> tuple[list[list[float]], str | None]:
    project = read_project()
    embedding_model_id = project.settings.modelRouting.embeddingModelId
    if not embedding_model_id:
        return [], "No embedding model is selected in project settings."

    registered_model = find_registered_model(embedding_model_id)
    if registered_model is None:
        return [], f"Embedding model is not registered: {embedding_model_id}"

    provider = find_provider(registered_model.providerId)
    if provider is None:
        return [], f"Provider is not registered: {registered_model.providerId}"

    try:
        return await create_embeddings(provider, registered_model.modelId, texts), None
    except ProviderRequestError as exc:
        return [], str(exc)


async def add_knowledge_document(title: str, text: str, tags: list[str]) -> KnowledgeDocumentCreateResponse:
    timestamp = _now_iso()
    document_id = f"doc-{uuid.uuid4()}"
    raw_chunks = _chunk_text(text)
    chunk_models = [
        KnowledgeChunk(
            id=f"chunk-{uuid.uuid4()}",
            documentId=document_id,
            text=chunk,
            ordinal=index,
            createdAt=timestamp,
        )
        for index, chunk in enumerate(raw_chunks)
    ]

    KNOWLEDGE_DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
    document_path = KNOWLEDGE_DOCUMENTS_DIR / f"{document_id}.txt"
    document_path.write_text(text, encoding="utf-8")

    metadata = read_knowledge_metadata()
    metadata.documents.append(
        KnowledgeDocument(
            id=document_id,
            title=title,
            sourcePath=str(document_path),
            tags=tags,
            chunkIds=[chunk.id for chunk in chunk_models],
            createdAt=timestamp,
            updatedAt=timestamp,
        )
    )
    metadata.updatedAt = timestamp
    write_knowledge_metadata(metadata)

    chunks = read_knowledge_chunks()
    chunks.chunks.extend(chunk.model_dump(mode="json") for chunk in chunk_models)
    write_knowledge_chunks(chunks)

    reindex_result = await reindex_knowledge_base()
    return KnowledgeDocumentCreateResponse(metadata=read_knowledge_metadata(), reindex=reindex_result)


async def reindex_knowledge_base() -> KnowledgeReindexResult:
    metadata = read_knowledge_metadata()
    chunks = [
        KnowledgeChunk.model_validate(item)
        for item in read_knowledge_chunks().chunks
    ]

    embedding_model_id, _, unavailable_reason = _embedding_model_config()
    if unavailable_reason:
        return KnowledgeReindexResult(indexedChunks=0, embeddingModelId=embedding_model_id, unavailableReason=unavailable_reason)

    embeddings, error = await _embed_texts([chunk.text for chunk in chunks])
    if error:
        return KnowledgeReindexResult(indexedChunks=0, embeddingModelId=embedding_model_id, unavailableReason=error)

    index = KnowledgeIndex(
        entries=[
            KnowledgeIndexEntry(
                chunkId=chunk.id,
                documentId=chunk.documentId,
                embeddingModelId=embedding_model_id or "",
                vector=embedding,
            )
            for chunk, embedding in zip(chunks, embeddings, strict=True)
        ]
    )
    write_knowledge_index(index)
    metadata.embeddingModelId = embedding_model_id
    metadata.updatedAt = _now_iso()
    write_knowledge_metadata(metadata)

    return KnowledgeReindexResult(indexedChunks=len(index.entries), embeddingModelId=embedding_model_id)


def _authorized_rag_nodes(target_node_id: str) -> tuple[list[CanvasNode], str | None]:
    project = read_project()
    target = next((node for node in project.nodes if node.id == target_node_id), None)
    if target is None:
        return [], f"Target node not found: {target_node_id}"
    if target.type != "paragraph":
        return [], "RAG retrieval is only available for paragraph targets."

    node_by_id = {node.id: node for node in project.nodes}
    authorizers: list[CanvasNode] = []
    for edge in project.edges:
        if edge.targetNodeId != target_node_id or edge.semantic != "reference":
            continue

        source = node_by_id.get(edge.sourceNodeId)
        if source is None:
            continue
        if source.type == "review":
            continue
        if "supplemental-info" in source.metadata.tags:
            authorizers.append(source)

    if not authorizers:
        return [], "No directly linked supplemental-info reference node authorizes RAG retrieval."

    return authorizers, None


async def preview_rag_for_target(target_node_id: str, limit: int) -> RagPreviewResponse:
    authorizers, unavailable_reason = _authorized_rag_nodes(target_node_id)
    if unavailable_reason:
        return RagPreviewResponse(authorized=False, unavailableReason=unavailable_reason)

    query_text = "\n\n".join(
        f"{node.title}\n{node.body or ''}".strip()
        for node in authorizers
    )
    query_vectors, error = await _embed_texts([query_text])
    if error:
        return RagPreviewResponse(
            authorized=True,
            authorizingNodeIds=[node.id for node in authorizers],
            unavailableReason=error,
        )

    index = read_knowledge_index()
    if not index.entries:
        return RagPreviewResponse(
            authorized=True,
            authorizingNodeIds=[node.id for node in authorizers],
            unavailableReason="Knowledge base index is empty.",
        )

    metadata = read_knowledge_metadata()
    document_titles = {document.id: document.title for document in metadata.documents}
    chunk_map = get_knowledge_chunk_map()
    query_vector = query_vectors[0]

    scored_entries = sorted(
        (
            (_cosine_similarity(query_vector, entry.vector), entry)
            for entry in index.entries
        ),
        key=lambda item: item[0],
        reverse=True,
    )

    snippets: list[RagSnippet] = []
    for score, entry in scored_entries[: max(1, min(limit, 20))]:
        chunk = chunk_map.get(entry.chunkId)
        if chunk is None:
            continue
        snippets.append(
            RagSnippet(
                chunkId=entry.chunkId,
                documentId=entry.documentId,
                documentTitle=document_titles.get(entry.documentId, entry.documentId),
                text=chunk.text,
                score=score,
            )
        )

    return RagPreviewResponse(
        authorized=True,
        authorizingNodeIds=[node.id for node in authorizers],
        snippets=snippets,
    )
