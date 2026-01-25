import type { PyodideInterface } from "pyodide";
import { loadPyodide } from "pyodide";

type RunPythonArgs = {
  code: string;
  packages?: string[];
  timeoutMs?: number;
};

type RunPythonResult = {
  success: boolean;
  output: string;
  image_base64: string;
  error: string | null;
  stdout: string;
  stderr: string;
  resultRepr: string | null;
  loadedPackages: string[];
};

const DEFAULT_PACKAGES = ["numpy", "pandas", "scipy", "sympy", "matplotlib"];

let pyodidePromise: Promise<PyodideInterface> | null = null;
const loadedPackages = new Set<string>();
let runChain: Promise<void> = Promise.resolve();

function pyodideLogWriter(kind: "stdout" | "stderr"): (msg: string) => void {
  const mode = (process.env.PYODIDE_LOG ?? "stderr").toLowerCase();
  if (mode === "off" || mode === "false" || mode === "0") return () => {};
  // IMPORTANT: MCP stdio transport uses stdout for the protocol. Never write Pyodide logs to stdout.
  return (msg) => {
    process.stderr.write(String(msg));
    if (!String(msg).endsWith("\n")) process.stderr.write("\n");
  };
}

async function getPyodide(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    const indexURL = process.env.PYODIDE_INDEX_URL?.trim();
    if (indexURL && /^https?:\/\//i.test(indexURL)) {
      throw new Error("PYODIDE_INDEX_URL must be a local filesystem path in Node (http(s) URLs are not supported).");
    }
    const options = {
      stdout: pyodideLogWriter("stdout"),
      stderr: pyodideLogWriter("stderr"),
    };
    pyodidePromise = indexURL
      ? loadPyodide({ ...options, indexURL: indexURL.endsWith("/") ? indexURL : `${indexURL}/` })
      : loadPyodide(options);
  }
  return pyodidePromise;
}

async function ensurePackages(pyodide: PyodideInterface, packages: string[]): Promise<void> {
  const toLoad = packages.filter((p) => !loadedPackages.has(p));
  if (toLoad.length === 0) return;
  await pyodide.loadPackage(toLoad);
  for (const p of toLoad) loadedPackages.add(p);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export async function runPython(args: RunPythonArgs): Promise<RunPythonResult> {
  // Pyodide runs in a single JS thread; serialize executions to avoid global-state collisions.
  const prev = runChain;
  let release!: () => void;
  runChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;

  try {
    const pyodide = await getPyodide();
    const packages = args.packages?.length ? args.packages : DEFAULT_PACKAGES;

    await ensurePackages(pyodide, packages);

    const runner = `
import io, json, traceback
from contextlib import redirect_stdout, redirect_stderr

_stdout = io.StringIO()
_stderr = io.StringIO()
_result_repr = None
_success = True
_error = None
_image_base64 = ""

try:
    compiled = compile(__CODE__, "<mcp>", "exec")
    local_ns = {}
    with redirect_stdout(_stdout), redirect_stderr(_stderr):
        exec(compiled, local_ns, local_ns)
    _result = local_ns.get("_")
    if _result is not None:
        try:
            _result_repr = repr(_result)
        except Exception:
            _result_repr = "<unreprable>"
except Exception:
    _success = False
    _error = traceback.format_exc()
    with redirect_stderr(_stderr):
        traceback.print_exc()

# Best-effort: capture matplotlib plot to base64 (if user created a figure)
try:
    import base64
    from io import BytesIO
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig = plt.gcf()
    axes = fig.get_axes() if fig else []
    has_data = False
    try:
        has_data = any(getattr(ax, "has_data", lambda: False)() for ax in axes)
    except Exception:
        has_data = bool(axes)

    if has_data:
        _buf = BytesIO()
        fig.savefig(_buf, format="png", dpi=100, bbox_inches="tight")
        _buf.seek(0)
        _image_base64 = base64.b64encode(_buf.getvalue()).decode("utf-8")
        _buf.close()
except Exception:
    _image_base64 = ""

json.dumps({
    "success": _success,
    "output": _stdout.getvalue() + _stderr.getvalue(),
    "image_base64": _image_base64,
    "error": _error,
    "stdout": _stdout.getvalue(),
    "stderr": _stderr.getvalue(),
    "resultRepr": _result_repr,
})
`;

    pyodide.globals.set("__CODE__", args.code);
    try {
      const jsonText = await withTimeout(pyodide.runPythonAsync(runner), args.timeoutMs);
      const parsed = JSON.parse(String(jsonText)) as any;

      return {
        success: !!parsed.success,
        output: typeof parsed.output === "string" ? parsed.output : "",
        image_base64: typeof parsed.image_base64 === "string" ? parsed.image_base64 : "",
        error: typeof parsed.error === "string" ? parsed.error : null,
        stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
        stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
        resultRepr: parsed.resultRepr ?? null,
        loadedPackages: Array.from(loadedPackages).sort(),
      };
    } finally {
      pyodide.globals.delete("__CODE__");
    }
  } finally {
    release();
  }
}

// Alias for compatibility with clients expecting `execute_python`-style naming.
export const executePython = runPython;
