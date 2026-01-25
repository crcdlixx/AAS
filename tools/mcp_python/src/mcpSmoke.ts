import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: "pipe",
});

const client = new Client({ name: "mcp-pyodide-smoke", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
if (!tools.tools.some((t) => t.name === "python.run")) {
  throw new Error("Expected tool python.run to be registered.");
}

const call = await client.callTool({
  name: "python.run",
  arguments: {
    code: "print(1+1)\n_ = 2+2",
    timeoutMs: 60_000,
  },
});

console.log(JSON.stringify({ tools: tools.tools.map((t) => t.name), call }, null, 2));
await transport.close();

