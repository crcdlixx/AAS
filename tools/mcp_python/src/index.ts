import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runPython } from "./pyodideRunner.js";

const server = new Server(
  { name: "mcp-pyodide-python", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "python.run",
        description:
          "Run Python code via Pyodide. Preloads common scientific libraries (numpy, pandas, scipy, sympy, matplotlib) unless overridden.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            code: { type: "string", description: "Python code to execute." },
            packages: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional list of Pyodide packages to load before execution. If omitted, a default scientific set is loaded.",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1,
              description:
                "Optional timeout for execution in milliseconds (best-effort; Pyodide itself is cooperative).",
            },
          },
          required: ["code"],
        },
      },
      {
        name: "execute_python",
        description: "Execute Python and return {success, output, image_base64, error} JSON-compatible payload.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            code: { type: "string", description: "Python code to execute." },
            packages: { type: "array", items: { type: "string" } },
            timeoutMs: { type: "integer", minimum: 1 },
          },
          required: ["code"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "python.run" && request.params.name !== "execute_python") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments ?? {};
  const code = typeof args.code === "string" ? args.code : "";
  const packages = Array.isArray(args.packages) ? args.packages.filter((p) => typeof p === "string") : undefined;
  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;

  const result = await runPython({ code, packages, timeoutMs });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
