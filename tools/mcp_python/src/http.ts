import http from "node:http";
import { URL } from "node:url";
import { executePython } from "./pyodideRunner.js";

export const port = Number.parseInt(process.env.MCP_HTTP_PORT || process.env.PORT || "8080", 10) || 8080;
export const host = process.env.MCP_HTTP_HOST || "127.0.0.1";
export const endpointPath = process.env.MCP_HTTP_PATH || "/method/execute_python";

const readBody = async (req: http.IncomingMessage): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
};

const sendJson = (res: http.ServerResponse, status: number, payload: unknown) => {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
};

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method !== "POST" || url.pathname !== endpointPath) {
      return sendJson(res, 404, { error: "Not found" });
    }

    const raw = await readBody(req);
    let data: any;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { success: false, output: "", image_base64: "", error: "Invalid JSON body" });
    }

    const code = typeof data?.code === "string" ? data.code : "";
    if (!code.trim()) {
      return sendJson(res, 400, { success: false, output: "", image_base64: "", error: "Missing `code`" });
    }

    const packages = Array.isArray(data?.packages) ? data.packages.filter((p: any) => typeof p === "string") : undefined;
    const timeoutMs = typeof data?.timeoutMs === "number" ? data.timeoutMs : undefined;

    const result = await executePython({ code, packages, timeoutMs });
    return sendJson(res, 200, result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return sendJson(res, 500, { success: false, output: "", image_base64: "", error: message });
  }
});

export const serverReady = new Promise<void>((resolve) => {
  server.listen(port, host, () => {
    process.stderr.write(`HTTP listening on http://${host}:${port}${endpointPath}\n`);
    resolve();
  });
});
