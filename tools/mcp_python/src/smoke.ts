import { runPython } from "./pyodideRunner.js";

const result = await runPython({
  code: `
import numpy as np
import pandas as pd

a = np.array([1,2,3])
print(a.mean())

df = pd.DataFrame({"x":[1,2,3], "y":[4,5,6]})
print(df.describe())
_ = df.shape
`,
  timeoutMs: 60_000,
});

console.log(JSON.stringify(result, null, 2));

