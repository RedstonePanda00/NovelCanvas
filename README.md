# Novel Canvas

Novel Canvas is a local-first, node-based writing workspace for long-form fiction. Organize outlines, scenes, characters, and paragraphs on a canvas, connect them with semantic edges, and use AI providers for structure planning, paragraph generation, and review.

The application runs entirely on your machine. Your novel project and knowledge base stay in local files; API keys are stored outside the repository.

## Features

- **Infinite canvas editor** — Search, place, move, connect, fit, and inspect paragraph, outline, scene, character, reference, instruction, and chapter nodes.
- **Semantic edges** — Link nodes with meanings such as `must_follow`, `reference`, `instruction`, and `style_reference`.
- **Project workflow** — Automatic queued saves, undo/redo, JSON backup/import, and automatic project loading.
- **Worldbook / Lorebook** — Trigger lore entries from node context using configurable keys.
- **Illustrations** — Add image nodes from the canvas palette, upload PNG/JPEG/WebP/GIF files up to 2 MB, and connect them to story fragments. Worldbook entries can upload illustrations or reuse existing image nodes. Images travel with project JSON backups and worldbook exports. Descriptions support text references; image pixels are not sent to AI providers.
- **Project Memory & RAG** — Explicitly index scene and paragraph nodes, detect stale memory, and retrieve continuity snippets during paragraph generation.
- **AI generation** — Structure plans, node completion, and paragraph streaming via OpenAI-compatible providers.
- **External agents** — Search, read and edit the current manuscript over local MCP.
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
- **Python 3.10 or later** (including Python 3.15.2)

## Quick start (Windows)

Double-click or run from the project root:

```bat
start.bat
```

This script will:

1. Create a Python virtual environment in `.venv` if needed
2. Install backend dependencies from `backend/requirements.txt`
3. Install frontend dependencies in `frontend/`
4. Start the backend on `http://127.0.0.1:53173`
5. Start the frontend on `http://127.0.0.1:5173`
6. Open the app in your browser

The launcher reuses an existing `.venv`. To switch that checkout to Python 3.15,
stop the app, rename `.venv`, then run `py -3.15 -m venv .venv` before starting
the app again.

## Manual setup

### Backend

```bat
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 53173 --reload
```

### Frontend

```bat
cd frontend
npm install
npm run dev -- --port 5173
```

Open `http://127.0.0.1:5173` in your browser.

## First run

### Connect an external writing agent

Start Novel Canvas with `start.bat`. The backend serves Streamable HTTP MCP at
`http://127.0.0.1:53173/mcp`. Both servers bind to the local IPv4 loopback address. The launcher stops on a conflicting listener. The browser can be closed. The agent uses its own model.

Register the running service in Codex:

```sh
codex mcp add novelcanvas --url http://127.0.0.1:53173/mcp
```

For DeepSeek Harness (dsh), add this entry to your profile's plugin list:

```yaml
- id: mcp-novelcanvas
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: novelcanvas
    transport: streamable-http
    url: http://127.0.0.1:53173/mcp
```

The [DSH MCP client guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) describes profile registration.

Try asking “Find the scene where the letter arrives, check the worldbook for the sender, and show me the passage.”
The runtime exposes paged node and lore searches, full text in pages, relationships,
node creation, exact passage replacement and directed connections. Writes take the
project revision returned by a read or the preceding write and save immediately.

Wait for the canvas to show **Saved** before handing work to an agent. Switching
focus back to a clean canvas checks the saved revision. External text edits keep
the current selection and viewport, and carry the new text through compatible
undo/redo history. Structural changes start a new undo history. If another writer
saved while you had a local draft, export your draft from the project menu before
reloading and reconciling it. Run one backend process per project file.

### Connecting nodes

Drag the arrow handle on the source node onto any part of the target node. Release, choose the relationship meaning, and confirm. The preview follows the pointer and the whole target highlights. Escape cancels. For distant nodes, use **Add a source for this node** in the inspector, search for the source, and choose the relationship. The displayed direction is always **source → target**. Keyboard users can use the search form, or activate an arrow handle with Enter and click the target.

The current project loads automatically. If no project file exists, the backend creates a default `project.json`. Use the **Project** menu to create a project, import JSON, export a backup, or save immediately.

Configure AI providers under **Settings** in the UI (provider URL, API key, model registration, and routing). After a role is saved or cleared, new projects inherit that choice on this device. Imported backups retain their own model assignments.

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
GET http://127.0.0.1:53173/health
```

Storage status (paths in use):

```text
GET http://127.0.0.1:53173/api/storage/status
```

## License

MIT — see [LICENSE](LICENSE).
