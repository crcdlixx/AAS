# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AAS (All The Answer Search / 全部答案搜题) is an AI-powered question-solving web application that uses image recognition, automatic subject classification, and multi-model orchestration to solve academic questions. The system supports both single-model and dual-model debate modes, with intelligent routing based on subject classification (文科/理科).

## Development Commands

```bash
# Install all dependencies (root, client, server, tools/mcp_python)
npm run install:all

# Start all services concurrently (client, server, MCP Python)
npm run dev

# Start individual services
npm run dev:client   # Frontend only (port 5173)
npm run dev:server   # Backend only (port 5174)
npm run dev:mcp      # MCP Python service only (port 8080)
```

**Environment Setup**: Copy `server/.env.example` to `server/.env` and configure API keys before running.

## Architecture Overview

### Three-Tier System

1. **Client** ([client/src/](client/src/)) - React + TypeScript frontend with image cropping, task management, and streaming result display
2. **Server** ([server/src/](server/src/)) - Express backend with automatic routing, multi-model orchestration, and usage tracking
3. **MCP Python** ([tools/mcp_python/](tools/mcp_python/)) - Model Context Protocol service for executing Python code (science questions)

### Automatic Routing System

The core innovation is the **automatic routing mechanism** that classifies questions and selects solving strategies:

**Flow**: `Router Model → Subject Classification → Mode Selection → Model Configuration → Solving`

**Key Files**:
- [server/src/services/router.ts](server/src/services/router.ts) - Subject classification logic
- [server/src/index.ts](server/src/index.ts) - Routing orchestration and endpoint handlers

**Classification**:
- **Subjects**: `'humanities'` (文科), `'science'` (理科), `'unknown'`
- **Modes**: `'single'` (one model) or `'debate'` (dual-model review)

**Configuration Pattern** (in `.env`):
```env
# Router model (lightweight classifier)
ROUTER_MODEL=gpt-4o-mini
ROUTER_API_KEY=  # Optional, defaults to OPENAI_API_KEY
ROUTER_BASE_URL= # Optional, defaults to OPENAI_BASE_URL

# Subject-specific modes
ROUTE_HUMANITIES_MODE=single
ROUTE_SCIENCE_MODE=debate
ROUTE_DEFAULT_MODE=debate

# Subject-specific models
ROUTE_SCIENCE_SINGLE_MODELS=gpt-4o
ROUTE_SCIENCE_DEBATE_MODELS=gpt-4o-mini,gpt-4o

# Per-subject model overrides (optional)
ROUTE_SCIENCE_DEBATE_MODEL1_API_KEY=
ROUTE_SCIENCE_DEBATE_MODEL1_BASE_URL=
ROUTE_SCIENCE_DEBATE_MODEL2_API_KEY=
ROUTE_SCIENCE_DEBATE_MODEL2_BASE_URL=
```

The router first calls a lightweight model (default: `gpt-4o-mini`) with vision to classify the question, then uses environment variables to determine which models and mode to use for solving.

### Dual-Model Debate System

**Purpose**: Improve answer quality through iterative refinement

**Architecture** ([server/src/services/debate.ts](server/src/services/debate.ts)):
```
Loop (max MAX_DEBATE_ITERATIONS):
  1. Model1 (Proposer) generates/refines answer
  2. Model2 (Reviewer) critiques the answer
  3. If review contains "APPROVED" → consensus reached, exit
  4. Otherwise, Model1 refines based on feedback
```

**Configuration**:
```env
MODEL1_NAME=gpt-4o-mini      # Proposer (faster, creative)
MODEL1_API_KEY=
MODEL1_BASE_URL=
MODEL2_NAME=gpt-4o           # Reviewer (stronger, critical)
MODEL2_API_KEY=
MODEL2_BASE_URL=
MAX_DEBATE_ITERATIONS=3
```

**State Management**: Uses LangGraph with `DebateState` containing question, images, model answers, reviews, iteration count, and consensus status.

**Streaming**: Emits real-time events (`model1`, `model2`, `status`) during debate for frontend display.

### MCP Python Integration

**Purpose**: Execute Python code for science questions (calculations, plotting, verification)

**Flow**:
1. When `routedSubject === 'science'` and `MCP_PYTHON_ENABLED !== '0'`
2. System appends hint to prompt asking for Python code block
3. After solving, [server/src/services/scienceMcp.ts](server/src/services/scienceMcp.ts) extracts ````python` blocks
4. Executes code via MCP service at `MCP_PYTHON_URL`
5. Appends execution results (output, images, errors) to answer

**MCP Service** ([tools/mcp_python/](tools/mcp_python/)):
- Built on Model Context Protocol with Pyodide (Python in Node.js)
- Exposes `execute_python` tool via HTTP endpoint
- Pre-loaded packages: numpy, pandas, scipy, sympy, matplotlib
- Returns JSON: `{success, output, image_base64, error}`

**Configuration**:
```env
MCP_PYTHON_ENABLED=1
MCP_PYTHON_URL=http://127.0.0.1:8080/method/execute_python
MCP_PYTHON_TIMEOUT_MS=120000
```

### Usage Tracking & Rate Limiting

**Architecture** ([server/src/services/usageLimit.ts](server/src/services/usageLimit.ts)):
- Per-client token tracking with rolling time windows
- Storage: JSON file (`usage-store.json`)
- Client identification: `X-AAS-Fingerprint` header → `X-Fingerprint` → `X-Client-Id` → IP address

**Configuration**:
```env
USAGE_LIMIT_TOKENS=100000      # Max tokens per window (0 = unlimited)
USAGE_LIMIT_WINDOW_HOURS=24   # Rolling window duration
```

**Middleware**: `usageGuard` checks limits before processing requests, throws `UsageLimitError` if exceeded.

**Response Headers**: Every response includes usage info:
```
X-Usage-Limit-Tokens: 100000
X-Usage-Used-Tokens: 5432
X-Usage-Remaining-Tokens: 94568
X-Usage-Reset-At: 2026-01-26T10:30:00Z
```

### API Override System

**Purpose**: Allow temporary per-request API configuration without changing `.env`

**Mechanism** ([server/src/services/apiOverride.ts](server/src/services/apiOverride.ts)):
- Client sends headers: `X-AAS-Api-Key`, `X-AAS-Base-Url`, `X-AAS-Model`
- Server merges with environment config (headers take precedence)
- Applies to router model, single model, and debate models

**Priority**: Request Headers > Environment Variables > Defaults

### Client Architecture

**Main Component** ([client/src/App.tsx](client/src/App.tsx)):
- Manages image uploads, cropping, and task execution
- Supports **cross-image merging**: combine crops from multiple images into single solving task
- Task center with streaming results, follow-up questions, and conversation history

**Key Features**:
- Multiple crops per image with grouping
- Real-time streaming with SSE (Server-Sent Events)
- Follow-up questions maintain conversation context (last 20 messages)
- Browser fingerprinting for usage tracking ([client/src/utils/fingerprint.ts](client/src/utils/fingerprint.ts))

**API Client** ([client/src/services/api.ts](client/src/services/api.ts)):
- Handles streaming with event parsing: `start`, `delta`, `complete`, `final`, `model1`, `model2`, `status`, `error`
- Extracts usage info from response headers
- Supports multi-image solving with prompt injection

## Key Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/solve-auto-stream` | Single image, auto-routing, SSE streaming |
| `POST /api/solve-multi-auto-stream` | Multiple images, auto-routing, SSE streaming |
| `POST /api/follow-up` | Continue questioning with conversation history |
| `GET /api/usage` | Get current token usage snapshot |

**Request Flow**:
```
Upload → usageGuard → routeQuestionFromImages() →
  [single mode: solveQuestionStream()] OR
  [debate mode: solveQuestionWithDebateStream()] →
  [if science: enrichScienceAnswerWithMcp()] →
  attachRouting() → addUsage() → Response
```

## Important Patterns

### Multi-Level Configuration
The system uses a cascading configuration pattern:
1. **Default**: Hardcoded in code (e.g., `gpt-4o`)
2. **Environment**: `.env` variables (e.g., `OPENAI_MODEL`)
3. **Subject-Specific**: Routing overrides (e.g., `ROUTE_SCIENCE_SINGLE_MODELS`)
4. **Per-Subject Model Config**: Fine-grained overrides (e.g., `ROUTE_SCIENCE_DEBATE_MODEL1_API_KEY`)
5. **Request Headers**: Temporary overrides (e.g., `X-AAS-Api-Key`)

### Streaming Architecture
All solving endpoints support SSE streaming:
- Server emits events as JSON: `data: {"type":"delta","value":"..."}\n\n`
- Client accumulates text and updates UI in real-time
- Final event includes complete result with metadata
- Fallback: If stream truncated by `max_tokens`, automatically retries without streaming

### Token Estimation
When actual token usage unavailable from API response:
- Uses tiktoken library for estimation
- Counts prompt tokens (images + text) and completion tokens
- Includes in usage tracking and response headers

## Environment Variables Reference

See [server/.env.example](server/.env.example) for complete list. Key categories:

- **Core API**: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_MAX_TOKENS`
- **Router**: `ROUTER_MODEL`, `ROUTER_API_KEY`, `ROUTER_BASE_URL`
- **Subject Modes**: `ROUTE_HUMANITIES_MODE`, `ROUTE_SCIENCE_MODE`, `ROUTE_DEFAULT_MODE`
- **Subject Models**: `ROUTE_*_SINGLE_MODELS`, `ROUTE_*_DEBATE_MODELS`
- **Subject Overrides**: `ROUTE_*_DEBATE_MODEL1_*`, `ROUTE_*_DEBATE_MODEL2_*`
- **Debate**: `MODEL1_NAME`, `MODEL1_API_KEY`, `MODEL1_BASE_URL`, `MODEL2_*`, `MAX_DEBATE_ITERATIONS`
- **MCP**: `MCP_PYTHON_ENABLED`, `MCP_PYTHON_URL`, `MCP_PYTHON_TIMEOUT_MS`
- **Usage**: `USAGE_LIMIT_TOKENS`, `USAGE_LIMIT_WINDOW_HOURS`

## File Organization

```
server/src/
├── index.ts                    # Main server, endpoints, routing orchestration
└── services/
    ├── router.ts              # Subject classification & routing decisions
    ├── openai.ts              # Single-model solving (streaming & non-streaming)
    ├── debate.ts              # Dual-model debate with LangGraph
    ├── scienceMcp.ts          # Science answer enrichment with Python
    ├── mcpPython.ts           # MCP client for Python execution
    ├── usageLimit.ts          # Token tracking & rate limiting
    ├── apiOverride.ts         # Request header override handling
    └── tokenUsage.ts          # Token estimation utilities

client/src/
├── App.tsx                    # Main component, state management, task execution
├── services/api.ts            # HTTP client, SSE streaming, usage tracking
└── utils/
    ├── cropBlob.ts            # Image cropping to JPEG blobs
    └── fingerprint.ts         # Browser fingerprinting for client ID

tools/mcp_python/src/
├── index.ts                   # MCP server setup
├── pyodideRunner.ts           # Python execution with Pyodide
└── http.ts                    # HTTP wrapper for MCP tools
```

## Working with This Codebase

**When modifying routing logic**: Update [server/src/services/router.ts](server/src/services/router.ts) and ensure environment variable handling in [server/src/index.ts](server/src/index.ts) is consistent.

**When adding new solving modes**: Extend the `ModelMode` type and add corresponding logic in both [server/src/index.ts](server/src/index.ts) (backend) and [client/src/App.tsx](client/src/App.tsx) (frontend).

**When modifying debate logic**: Update [server/src/services/debate.ts](server/src/services/debate.ts) and ensure streaming events are properly handled in [client/src/services/api.ts](client/src/services/api.ts).

**When adding MCP tools**: Extend [tools/mcp_python/src/index.ts](tools/mcp_python/src/index.ts) with new tool definitions and update [server/src/services/scienceMcp.ts](server/src/services/scienceMcp.ts) to use them.

**When changing usage tracking**: Modify [server/src/services/usageLimit.ts](server/src/services/usageLimit.ts) and ensure headers are properly set in [server/src/index.ts](server/src/index.ts) endpoints.
