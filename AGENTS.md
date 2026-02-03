# Repository Guidelines

## Project Structure & Module Organization
- `client/` houses the React + Vite UI.
- `server/` contains the Express API, routing, and model orchestration.
- `tools/mcp_python/` hosts the MCP Python service used for science calculations.
- `apps/desktop/` and `apps/mobile/` provide desktop/mobile wrappers and sync scripts.
- `docs/` and `DOCKER.md` document deployment and operations.

## Build, Test, and Development Commands
- `npm run install:all` (root) installs dependencies for root, client, server, and MCP service.
- `npm run dev` (root) starts client, server, and MCP concurrently.
- `npm run dev:client`, `npm run dev:server`, `npm run dev:mcp` run services independently.
- `npm run build` in `client/` builds the frontend; `npm run preview` serves the build.
- `npm run build` in `server/` compiles TypeScript; `npm start` runs `dist/`.
- `npm run test` in `server/` runs the Node test for streaming behavior.
- `npm run build`/`npm run start` in `tools/mcp_python/` builds and runs the MCP service.
- `docker compose up -d` (see `DOCKER.md`) runs the full stack in containers.

## Coding Style & Naming Conventions
- TypeScript + ES modules (client and server set `"type": "module"`).
- Use 2-space indentation, single quotes, and no semicolons to match existing files.
- React components use PascalCase filenames (e.g., `client/src/components/MarkdownView.tsx`).
- Server services and utilities use camelCase filenames (e.g., `server/src/services/openai.ts`).
- Tests use the `.test.ts` suffix (e.g., `openai.streamEvents.test.ts`).

## Testing Guidelines
- Server tests: run `npm run test` in `server/`.
- No automated client tests are configured; verify UI changes manually.
- Use `node server/test-config.js` to validate `.env` setup before API testing.

## Commit & Pull Request Guidelines
- Commit history favors short prefixes like `feat:` and `fix:`, sometimes with scopes
  (e.g., `feat(desktop): ...`). Keep to that style.
- PRs should include a concise summary, tests run (or “not run”), and UI screenshots
  when the frontend changes.
- Call out config/env changes and update docs if behavior or setup steps change.

## Configuration & Secrets
- Backend config lives in `server/.env` (copy from `server/.env.example`).
- Docker-specific variables live in the root `.env`.
- Never commit real API keys or credentials.
