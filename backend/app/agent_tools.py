"""Single registry for tool descriptions, typed arguments and execution bindings."""
import inspect
import json
from typing import get_type_hints
from pydantic import BaseModel, ConfigDict, Field, create_model
from .models import ChatBlock


class FinishArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    reply: str = Field(min_length=1)
    blocks: list[ChatBlock] = Field(default_factory=list, max_length=12)


FINISH_TOOL = {"name": "finish_task", "description": "Return the final answer/report and finish this request. Use when the question is answered or requested changes have been verified and planned targets completed. The application validates changes before committing; unfinished targets reject this call. Do not keep searching after the request is satisfied.",
               "parameters": FinishArguments.model_json_schema()}

DESCRIPTIONS = {'search_nodes': 'literal case-insensitive title/body search. Empty query lists all nodes. '
                 'Offset=0 starts a fresh search of current text. Subsequent pages use the fixed '
                 'result IDs from that search, so patches do not shift offsets. Follow nextOffset '
                 'to cover all results, then start at offset=0 to verify remaining matches. Try '
                 'synonyms or enumerate relevant node types for conceptual searches.',
 'read_node': 'read current text and relationships; paginate long text. Returns revision.',
 'patch_node': 'stage an exact unique replacement in a passage you have read. Use surrounding text '
               'to disambiguate. Preserves all other text. Supports deleting a passage with '
               'newText="". On stale revision read again.',
 'list_changes': 'list staged changes and whether each has been fully reread after the last patch.',
 'search_worldbook': 'search enabled world facts by title, keywords or content.',
 'read_worldbook': 'read an enabled worldbook entry. read_node returns matching entry IDs; consult '
                   'relevant entries before revising dependent facts. Keyword hits do not require '
                   'repeating those facts in prose.',
 'create_node': 'create a node in the working manuscript. Types: paragraph, outline, scene, '
                'character, supplemental_info, instruction. The returned ID can be read, patched, '
                "and used as another creation's anchor. Read references first. An empty project "
                'needs no anchor. Reread each new node before finishing.',
 'rename_node': 'rename a fully read node. Reread to verify the new title.',
 'plan_work': 'REQUIRED before any mutation. Creates a durable worklist of ALL matching nodes. For '
              'whole-book revision/review use query="" when requirements are conceptual or may use '
              'different words. For focused changes supply explicit nodeIds. For creation-only or '
              'worldbook-only work use nodeIds=[]. Every newly created/modified node is also added '
              'automatically. Complete each target with complete_target. This requirement is '
              'enforced by the server.',
 'work_status': 'counts and next unfinished targets. Use this instead of keeping hundreds of IDs '
                'in memory.',
 'complete_target': 'after fully reading and checking the current node, record what you changed or '
                    'why you left it unchanged. A later patch reopens it. You cannot finish while '
                    'planned targets remain. Complete every item, then inspect cross-node '
                    'consistency before done=true.',
 'list_relationships': 'page through incoming/outgoing relationships. read_node returns the first '
                       'page.',
 'matching_worldbook': 'page through activated worldbook entries. read_node returns the first '
                       'page. Read relevant entries separately.',
 'set_relationship': 'add/remove a directed relationship after reading both endpoints. Semantics: '
                     'reference, must_follow, instruction, can_rewrite, style_reference. Source '
                     'supplies material/instructions to target. Use only when the author asks to '
                     'connect, restructure, or change these relationships.',
 'delete_node': 'delete a fully read node only when explicitly requested; removes incident edges '
                'and references, but preserves child nodes. All effects are recorded for rollback.',
 'patch_worldbook': 'change an exact unique passage in a fully read worldbook entry only when '
                    'explicitly requested to change canon. Reread the changed entry afterward.',
 'create_worldbook': 'add a new worldbook entry only when requested. Reread it afterward. '
                     'Speculative brainstorming alone must stay in chat and must not become canon.'}

BINDINGS = {
    "search_nodes": "search", "read_node": "read", "patch_node": "patch",
    "create_node": "create", "rename_node": "rename", "list_changes": "changes",
    **{name: name for name in DESCRIPTIONS if name not in {
        "search_nodes", "read_node", "patch_node", "create_node", "rename_node", "list_changes"}},
}
MUTATING = {"patch_node", "create_node", "rename_node", "delete_node",
            "set_relationship", "patch_worldbook", "create_worldbook"}

def argument_model(handler):
    hints = get_type_hints(handler)
    fields = {name: (hints.get(name, str), ... if parameter.default is inspect.Parameter.empty else parameter.default)
              for name, parameter in inspect.signature(handler).parameters.items()}
    return create_model(handler.__name__ + "Arguments", __config__=ConfigDict(extra="forbid", strict=True), **fields)

def definitions(workspace):
    return [{"name": name, "description": DESCRIPTIONS[name],
             "parameters": argument_model(getattr(workspace, method)).model_json_schema()}
            for name, method in BINDINGS.items()
            if (workspace.allow_writes or name not in MUTATING)
            and (workspace.write_node_ids is None or name not in MUTATING or name in {"patch_node", "rename_node"})]

def describe_tools(workspace):
    return json.dumps([*definitions(workspace), FINISH_TOOL], ensure_ascii=False)

def invoke(workspace, name, arguments):
    if name not in BINDINGS:
        raise ValueError(f"Unknown tool: {name}")
    handler = getattr(workspace, BINDINGS[name])
    validated = argument_model(handler).model_validate(arguments).model_dump()
    return handler(**validated)
