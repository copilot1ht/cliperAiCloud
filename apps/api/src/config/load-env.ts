import { config } from "dotenv";
import path from "node:path";

export function loadWorkspaceEnv(): void {
  config({
    path: [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../../.env")],
    quiet: true,
  });
}
