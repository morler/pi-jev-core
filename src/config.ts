import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface JevConfig {
  platform?: string;
  logging?: boolean;
}

export function configPath(): string {
  return process.env.JEV_CONFIG_FILE?.trim() || path.join(os.homedir(), ".pi", "agent", "pi-jev-core.json");
}

export function readConfig(): JevConfig {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as JevConfig : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Unable to read pi-jev-core config:", error instanceof Error ? error.message : String(error));
    }
    return {};
  }
}

export function updateConfig(update: Partial<JevConfig>): void {
  const file = configPath();
  const config = { ...readConfig(), ...update };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}
