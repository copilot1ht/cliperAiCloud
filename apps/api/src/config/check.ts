import { validateRuntimeConfig } from "./runtime-config.js";
import { loadWorkspaceEnv } from "./load-env.js";

loadWorkspaceEnv();
const report = validateRuntimeConfig();
console.log(JSON.stringify(report, null, 2));
if (!report.ready) process.exitCode = 1;
