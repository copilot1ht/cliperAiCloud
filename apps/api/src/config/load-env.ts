import { config } from "dotenv";
import path from "node:path";

export function loadWorkspaceEnv(): void {
  const production = String(process.env.NODE_ENV || "development").toLowerCase() === "production";
  if (production && String(process.env.LOAD_DOTENV_IN_PRODUCTION || "").toLowerCase() !== "true") return;
  config({
    path: [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../../.env")],
    quiet: true,
  });
}
