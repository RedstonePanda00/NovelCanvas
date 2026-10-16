# Novel Canvas

Novel Canvas is a local-first, node-based writing workspace for long-form fiction. Organize outlines, scenes, characters, and paragraphs on a canvas, connect them with semantic edges, and use AI providers for structure planning, paragraph generation, and review.

The application runs entirely on your machine. Your novel project and knowledge base stay in local files; API keys are stored outside the repository.

## Features

- **Infinite canvas editor** — Search, place, move, connect, fit, and inspect paragraph, outline, scene, character, reference, instruction, and chapter nodes.
- **Semantic edges** — Link nodes with meanings such as `must_follow`, `reference`, `instruction`, and `style_reference`.
- **Project workflow** — Automatic queued saves, undo/redo, JSON backup/import, and automatic project loading.
- **Worldbook / Lorebook** — Trigger lore entries from node context using configurable keys.
- **Project Memory & RAG** — Explicitly index scene and paragraph nodes, detect stale memory, and retrieve continuity snippets during paragraph generation.
- **AI generation** — Structure plans, node completion, paragraph streaming, and conversational design/review via OpenAI-compatible providers.
- **Export** — Export selected nodes to TXT (assets or manuscript mode).
- **Bilingual workspace** — Switch between English and Simplified Chinese independently from the project's writing language.

## Tech stack

| Layer | Stack |
|-------|--------|
| Frontend | React 19, TypeScript, Vite |
| Backend | Python 3, FastAPI, Uvicorn, Pydantic |
| Storage | JSON files on disk |

## Requirements

- **Node.js** (includes `npm`)
- **Python 3.10+**

## Quick start (Windows)

Double-click or run from the project root:

```bat
start.bat
```

This script will:

1. Create a Python virtual environment in `.venv` if needed
2. Install backend dependencies from `backend/requirements.txt`
3. Install frontend dependencies in `frontend/`
4. Start the backend on `http://127.0.0.1:8000`
5. Start the frontend on `http://127.0.0.1:5173`
6. Open the app in your browser

## Manual setup

### Backend

```bat
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload
```

### Frontend

```bat
cd frontend
npm install
npm run dev -- --port 5173
```

Open `http://127.0.0.1:5173` in your browser.

## First run

### Design discussion and revision

Choose **Settings → Chat model (global)** from your registered text models. This model is shared across projects and handles design, review reports, and feedback revisions. Paragraph and structure generation keep their own model routes; review no longer has a dedicated route or node type.

Expand **Writing chat** from the narrow strip at the far right. Chat opens to the right of the original inspector, so node details and relationships remain visible alongside it. Folding chat returns it to that strip. Drafts, targets and running requests survive selection changes and folding.

The chat area uses a conversation list beside the current conversation, with separate collapse controls for the list and the chat body. The original node inspector remains to their left. Use **New conversation** or the header's **+** button to start a chat; search and select existing conversations in the list. A fresh conversation has its composer near the top, moving to the bottom when a request starts. Scope, node attachments and send/stop controls live inside the composer, with the global chat model shown below. On narrow windows the list opens as a drawer. Conversations belong to the current novel project; each keeps its own draft, messages, writable targets, expanded read permissions and change history. A conversation is automatically named from its first sent message. Switching conversations keeps running requests in their originating conversation. Existing chat history is retained as the first conversation.

**Delete conversation** asks for confirmation and removes that conversation's messages, reports, draft and modification history. It cancels the conversation's running request without reverting manuscript changes. History is not transferred to nodes or other conversations. Deleting the last conversation leaves a fresh empty chat.

Reports, reviews and collected design plans can be returned as **named blocks** inside chat. Each has a title, collapsible text and **Copy full text**. Only the latest set of report blocks is retained in each conversation; a new report replaces its older blocks. The complete latest report is included in subsequent conversation context. Requesting a report alone does not write manuscript nodes.

Chat replies, reports and step progress stream as they are generated. Project-agent edits apply as one transaction after the completed work passes validation. Stopping, disconnecting, or receiving invalid output does not commit a partial edit. Each conversation retains only its latest modification batch for comparison or rollback; records never appear in other conversations.

Older Review nodes migrate to supplemental-information nodes when a project is loaded, retaining IDs, text, position and edges. A `legacy-review` tag marks their origin; existing review relationships remain readable for compatibility. This keeps old editorial notes out of automatic prose context unless the author changes their classification. Chat can read them when attached or authorized. The migration is stored with the next project save.

- Chat normally about design, tradeoffs and reasons. Use Enter to send and Shift+Enter for a newline.
- Drag node rows from the navigator, or a node's chat grip, onto the chat panel to attach writable targets. The **Attach selected node** button provides a keyboard alternative. Several targets can be attached.
- Ask to revise text or create a character/scene/other asset. The model returns structured operations; the application validates and directly applies them, preserving originals in **Change history**. Explanations remain in chat, separate from node content.

**Entire project · automatic search** is the default scope. You can ask, for example, “Find repeated descriptions of this character throughout the novel and remove the repetition while preserving the action.” Attachments are optional focus hints. The agent can search all nodes, read passages and relationships, consult relevant worldbook facts, patch or rename nodes, create dependent nodes, and check the resulting text. Explicit requests can also change relationships, delete nodes, or update/add worldbook facts. Deleting a node removes its incident relationships and references while preserving its child nodes. Discussion and speculative ideas are not requests to write or change canon.

For whole-book tasks, the agent builds a durable worklist and completes each target after reading and checking it. Unfinished targets prevent completion. Searches keep stable result IDs while pages are processed, so editing or deleting an earlier hit cannot skip later hits. Text, relationships and lore are paginated rather than placing the entire novel into a single model prompt. A coverage summary reports how many nodes were read and how many planned targets were completed.

Tools are registered with a description, typed JSON argument schema and an execution handler. The coordinator chooses its tools and can call `delegate_parallel` for up to two independent workers using the configured chat model. Each worker has its own context, tools and project snapshot; writable node assignments must be disjoint. Workers can research the project and revise assigned text/titles. The coordinator handles creation, deletion, relationships and canon changes, and must reread merged edits and resolve cross-task inconsistencies before completion. Simple chat needs no workers. Parallelism is optional and uses additional model calls; it does not guarantee literary correctness.

Worker activity streams into the chat activity log. A failed or cancelled parallel batch merges nothing. Successful batches merge into the coordinator's working copy and are included in its next checkpoint. Interrupting a batch resumes from the preceding coordinator checkpoint, so unfinished workers run again; individual worker checkpoints are not persisted. Each worker is limited to 32 model steps and ten minutes, with no recursive delegation. The coordinator can split a large manuscript into multiple batches. Tool calls still use the provider-compatible JSON protocol, not native function calling.

**Attached nodes only** retains the narrower workflow: **Read scope** shows the targets, one automatic incoming reference layer, and triggered worldbook entries. Deeper references require **Allow reading**; references remain read-only unless attached as targets. Without attachments this mode supports general discussion. Only the latest 24 messages are sent as conversation history; a running project task also maintains its own working memory and durable worklist.

**Agent activity** shows completed steps. A project task saves an incremental checkpoint with its conversation after each tool step. **Stop** leaves a resumable checkpoint; **Resume task** continues after a provider interruption or page reload. **Discard staged run** drops its unpublished changes. If manuscript text, structure, settings or worldbook changed during the interruption, the old checkpoint is rejected so you can start from the current version. Moving canvas nodes does not invalidate a checkpoint. Deleting a conversation also removes its checkpoint.

Each text change supports comparison, continued revision and rollback. A project transaction checks its original text and affected structure/canon against the current project; a conflict leaves the whole transaction pending rather than applying only part of it. **Roll back entire batch** restores text, deleted nodes, relationships and worldbook changes together, or refuses the rollback if affected data has newer changes. Individual text rollback preserves unrelated canvas metadata. Newly created nodes are removed in dependency order during batch rollback. Migrated review notes can still supply editable feedback through **Use review feedback**; bringing notes into the composer alone does not invoke the model. Existing generation workflows still produce candidates for explicit acceptance.

For **Outline → Generate scenes**, choose a scene count (1–12). That many pending scene nodes appear immediately, before the model responds. Titles and scene briefs stream into those same slots. Accept becomes available only when all requested scenes are complete; cancellation or failure removes the incomplete preview. Scene generation uses the structure model route.

Discussion, scopes, checkpoints and change history are saved with project JSON and included in backups. Manuscript TXT export uses current node content. Opening another project cancels its running request. The agent uses a bounded multi-step loop through the configured chat model; an exhausted step limit leaves a resumable task rather than claiming completion. Model interpretation and literary judgment still depend on the chosen model. No internet browsing, shell execution or access to other projects is provided to the writing agent.

### Connecting nodes

Drag the arrow handle on the source node onto any part of the target node. Release, choose the relationship meaning, and confirm. The preview follows the pointer and the whole target highlights. Escape cancels. For distant nodes, use **Add a source for this node** in the inspector, search for the source, and choose the relationship. The displayed direction is always **source → target**. Keyboard users can use the search form, or activate an arrow handle with Enter and click the target.

The current project loads automatically. If no project file exists, the backend creates a default `project.json`. Use the **Project** menu to create a project, import JSON, export a backup, or save immediately.

Configure AI providers under **Settings** in the UI (provider URL, API key, model registration, and routing).

## Data & privacy

Novel Canvas separates **application code** from **personal writing data**:

| Data | Default location | In git? |
|------|------------------|---------|
| Novel project | `./project.json` | No (gitignored) |
| Project Memory index | `./knowledge-base/` | No (gitignored) |
| API keys & provider config | `%APPDATA%\NovelCanvas\local-app-config.json` (Windows) | No (outside repo) |
| Runtime logs | `./.logs/` | No (gitignored) |

On Windows, local app config is stored at:

```text
%APPDATA%\NovelCanvas\local-app-config.json
```

On other platforms, the fallback is `~/.novelcanvas/local-app-config.json`.

Project JSON never stores API keys. Export/import uses the `ProjectFile` format only.

## Environment variables

Override default paths when needed:

| Variable | Purpose | Default |
|----------|---------|---------|
| `NOVEL_CANVAS_PROJECT_FILE` | Project JSON path | `./project.json` |
| `NOVEL_CANVAS_KNOWLEDGE_BASE_DIR` | Knowledge base directory | `./knowledge-base` |
| `NOVEL_CANVAS_CONFIG_DIR` | Local app config directory | `%APPDATA%/NovelCanvas` or `~/.novelcanvas` |

Example (PowerShell):

```powershell
$env:NOVEL_CANVAS_PROJECT_FILE = "D:\Writing\my-novel\project.json"
$env:NOVEL_CANVAS_KNOWLEDGE_BASE_DIR = "D:\Writing\my-novel\knowledge-base"
```

## Project structure

```text
NovelCanvas/
├── backend/           # FastAPI API and generation logic
├── frontend/        # React + Vite UI
├── start.bat          # Windows one-click launcher
├── project.json       # Your novel project (local, gitignored)
├── knowledge-base/    # Derived Project Memory index (local, gitignored)
└── .gitignore
```

## Development

Build the frontend for production:

```bat
cd frontend
npm run build
```

Run validation and tests:

```bat
.venv\Scripts\python.exe -m unittest discover -s backend\tests -v
cd frontend
npm run typecheck
npm test
npm run test:e2e
npm run check:api
```

When Pydantic request or response models change, regenerate the checked frontend OpenAPI contract:

```bat
cd frontend
npm run generate:api
```

Backend health check:

```text
GET http://127.0.0.1:8000/health
```

Storage status (paths in use):

```text
GET http://127.0.0.1:8000/api/storage/status
```

## License

MIT — see [LICENSE](LICENSE).
