import { server, serverReady, host, port, endpointPath } from "./http.js";

const run = async () => {
  await serverReady;

  const url = `http://${host}:${port}${endpointPath}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "print(1+2)" }),
  });

  const text = await response.text();
  process.stdout.write(`${response.status}\n${text}\n`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
};

run().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`httpSmoke failed: ${message}\n`);
  process.exitCode = 1;
});

