from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone

from .ai_provider import ProviderRequestError, create_embeddings
from .models import (
    CanvasNode,
    KnowledgeChunk,
    KnowledgeChunks,
    KnowledgeBaseMetadata,
    KnowledgeDocument,
    KnowledgeIndex,
    KnowledgeIndexEntry,
    KnowledgeReindexResult,
    ProjectFile,
    RagPreviewResponse,
    RagSnippet,
)
from .stores import (
    find_provider,
    find_registered_model,
    get_knowledge_chunk_map,
    read_knowledge_index,
    read_knowledge_metadata,
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


def _node_memory_text(node: CanvasNode) -> str:
    tags = f"Tags: {', '.join(node.metadata.tags)}\n" if node.metadata.tags else ""
    return f"Title: {node.title}\nType: {node.type}\n{tags}Body:\n{node.body or ''}".strip()


def _project_memory_nodes(project: ProjectFile) -> list[CanvasNode]:
    return [
        node
        for node in project.nodes
        if node.type in {"scene", "paragraph"} and (node.body or "").strip()
    ]


def _cosine_similarity(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left or not right:
        return 0.0

    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if not left_norm or not right_norm:
        return 0.0

    return dot / (left_norm * right_norm)


def project_memory_fingerprint(project: ProjectFile) -> str:
    payload = [
        {
            "id": node.id,
            "type": node.type,
            "title": node.title,
            "body": node.body or "",
            "tags": node.metadata.tags,
            "updatedAt": node.metadata.updatedAt,
        }
        for node in _project_memory_nodes(project)
    ]
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def memory_metadata_for_project(project: ProjectFile) -> KnowledgeBaseMetadata:
    metadata = read_knowledge_metadata().model_copy(deep=True)
    metadata.stale = metadata.sourceFingerprint != project_memory_fingerprint(project)
    return metadata


def _embedding_model_config(project: ProjectFile) -> tuple[str | None, str | None, str | None]:
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


async def _embed_texts(project: ProjectFile, texts: list[str]) -> tuple[list[list[float]], str | None]:
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


async def reindex_knowledge_base(project: ProjectFile) -> KnowledgeReindexResult:
    timestamp = _now_iso()
    chunk_models: list[KnowledgeChunk] = []
    documents: list[KnowledgeDocument] = []
    for node in _project_memory_nodes(project):
        raw_chunks = _chunk_text(_node_memory_text(node))
        if not raw_chunks:
            continue
        document_id = node.id
        node_chunks = [
            KnowledgeChunk(
                id=f"chunk-{node.id}-{index}",
                documentId=document_id,
                text=chunk,
                ordinal=index,
                createdAt=timestamp,
            )
            for index, chunk in enumerate(raw_chunks)
        ]
        chunk_models.extend(node_chunks)
        documents.append(
            KnowledgeDocument(
                id=document_id,
                title=node.title or node.id,
                sourcePath=f"project.json#nodes/{node.id}",
                tags=[node.type, *node.metadata.tags],
                chunkIds=[chunk.id for chunk in node_chunks],
                createdAt=node.metadata.createdAt or timestamp,
                updatedAt=node.metadata.updatedAt or timestamp,
            )
        )

    metadata = read_knowledge_metadata()
    metadata.id = "project-memory"
    metadata.title = f"{project.title or 'Project'} Memory"
    metadata.documents = documents
    metadata.embeddingModelId = None
    metadata.sourceFingerprint = project_memory_fingerprint(project)
    metadata.stale = False
    metadata.updatedAt = timestamp
    write_knowledge_metadata(metadata)
    write_knowledge_chunks(KnowledgeChunks(chunks=[chunk.model_dump(mode="json") for chunk in chunk_models]))

    embedding_model_id, _, unavailable_reason = _embedding_model_config(project)
    if unavailable_reason:
        write_knowledge_index(KnowledgeIndex())
        return KnowledgeReindexResult(indexedChunks=0, embeddingModelId=embedding_model_id, unavailableReason=unavailable_reason)

    if not chunk_models:
        write_knowledge_index(KnowledgeIndex())
        return KnowledgeReindexResult(indexedChunks=0, embeddingModelId=embedding_model_id, unavailableReason="Project memory has no node body text to index.")

    embeddings, error = await _embed_texts(project, [chunk.text for chunk in chunk_models])
    if error:
        write_knowledge_index(KnowledgeIndex())
        return KnowledgeReindexResult(indexedChunks=0, embeddingModelId=embedding_model_id, unavailableReason=error)

    index = KnowledgeIndex(
        entries=[
            KnowledgeIndexEntry(
                chunkId=chunk.id,
                documentId=chunk.documentId,
                embeddingModelId=embedding_model_id or "",
                vector=embedding,
            )
            for chunk, embedding in zip(chunk_models, embeddings, strict=True)
        ]
    )
    write_knowledge_index(index)
    metadata.embeddingModelId = embedding_model_id
    metadata.updatedAt = _now_iso()
    write_knowledge_metadata(metadata)

    return KnowledgeReindexResult(indexedChunks=len(index.entries), embeddingModelId=embedding_model_id)


def _rag_query_nodes(
    project: ProjectFile,
    target_node_id: str,
) -> tuple[CanvasNode | None, list[CanvasNode], str | None]:
    target = next((node for node in project.nodes if node.id == target_node_id), None)
    if target is None:
        return None, [], f"Target node not found: {target_node_id}"
    if target.type != "paragraph":
        return target, [], "Project memory retrieval is only available for paragraph targets."

    node_by_id = {node.id: node for node in project.nodes}
    query_nodes: list[CanvasNode] = []
    for edge in project.edges:
        if edge.targetNodeId != target_node_id or edge.semantic != "reference":
            continue

        source = node_by_id.get(edge.sourceNodeId)
        if source is None:
            continue
        if "legacy-review" in source.metadata.tags:
            continue
        query_nodes.append(source)

    return target, query_nodes, None


async def preview_rag_for_target(
    project: ProjectFile,
    target_node_id: str,
    limit: int,
) -> RagPreviewResponse:
    metadata = memory_metadata_for_project(project)
    target, query_nodes, unavailable_reason = _rag_query_nodes(project, target_node_id)
    if unavailable_reason:
        return RagPreviewResponse(authorized=False, unavailableReason=unavailable_reason, stale=metadata.stale)
    if target is None:
        return RagPreviewResponse(
            authorized=False,
            unavailableReason=f"Target node not found: {target_node_id}",
            stale=metadata.stale,
        )
    if metadata.stale:
        return RagPreviewResponse(
            authorized=True,
            authorizingNodeIds=[node.id for node in query_nodes],
            unavailableReason="Project memory is out of date. Rebuild the memory index first.",
            stale=True,
        )

    query_text = "\n\n".join(
        _node_memory_text(node)
        for node in [target, *query_nodes]
    )
    query_vectors, error = await _embed_texts(project, [query_text])
    if error:
        return RagPreviewResponse(
            authorized=True,
            authorizingNodeIds=[node.id for node in query_nodes],
            unavailableReason=error,
            stale=metadata.stale,
        )

    index = read_knowledge_index()
    if not index.entries:
        return RagPreviewResponse(
            authorized=True,
            authorizingNodeIds=[node.id for node in query_nodes],
            unavailableReason="Project memory index is empty. Reindex project memory first.",
            stale=metadata.stale,
        )

    document_titles = {document.id: document.title for document in metadata.documents}
    chunk_map = get_knowledge_chunk_map()
    query_vector = query_vectors[0]

    scored_entries = sorted(
        (
            (_cosine_similarity(query_vector, entry.vector), entry)
            for entry in index.entries
            if entry.documentId != target_node_id
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
        authorizingNodeIds=[node.id for node in query_nodes],
        snippets=snippets,
        stale=metadata.stale,
    )
