# live-caption-translator
## Environment variables

Create a `.env` file at the repo root (copy from `.env.example`) and set:

- `OPENAI_API_KEY` (required)
- `ASR_MODEL` (optional, default `whisper-1`)
- `LLM_MODEL` (optional, default `gpt-4o-mini`)
- `NEXT_PUBLIC_API_BASE_URL` (optional for frontend, defaults to `http://localhost:8000`)

When using Docker Compose, the `.env` file will be picked up automatically.

## Docker

Build and run two containers (backend + frontend):

```sh
docker compose up --build
```

Then open the app at http://localhost:3000. The backend API runs at http://localhost:8000.

for professor Gang
