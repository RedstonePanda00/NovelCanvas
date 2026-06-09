# Novel Canvas

Novel Canvas is a local-first, node-based writing workspace for long-form fiction. Organize outlines, scenes, characters, and paragraphs on a canvas, connect them with semantic edges, and use AI providers for structure planning, paragraph generation, and review.

The application runs entirely on your machine. Your novel project and knowledge base stay in local files; API keys are stored outside the repository.

## Features

- **Canvas editor** — Create, move, resize, and connect nodes (paragraph, outline, scene, character, review, and more).
- **Semantic edges** — Link nodes with meanings such as `must_follow`, `reference`, `instruction`, and `review_target`.
- **Project workflow** — Read, save, save as JSON, load JSON, or create a new project on startup.
- **Worldbook / Lorebook** — Trigger lore entries from node context using configurable keys.
- **Knowledge base & RAG** — Add local documents and retrieve snippets during paragraph generation.
- **AI generation** — Structure plans, node completion, paragraph streaming, and review generation via OpenAI-compatible providers.
- **Export** — Export selected nodes to TXT (assets or manuscript mode).

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

On first launch, choose one of:

- **Read Current Project** — load the saved project file
- **Load Project JSON** — import a project from disk
- **New Project** — create a blank canvas project

If no project file exists yet, the backend creates a default `project.json` on startup.

Configure AI providers under **Settings** in the UI (provider URL, API key, model registration, and routing).

## Data & privacy

Novel Canvas separates **application code** from **personal writing data**:

| Data | Default location | In git? |
|------|------------------|---------|
| Novel project | `./project.json` | No (gitignored) |
| Knowledge base | `./knowledge-base/` | No (gitignored) |
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
├── knowledge-base/    # Your RAG documents (local, gitignored)
└── .gitignore
```

## Development

Build the frontend for production:

```bat
cd frontend
npm run build
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
