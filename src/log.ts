import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const defaultLogFile = join(homedir(), ".pi", "agent", "jev-log.jsonl");
const defaultStateFile = join(homedir(), ".pi", "agent", "jev-log-enabled");

function filePath(envName: string, fallback: string): string {
  return process.env[envName]?.trim() || fallback;
}

export function isJevLoggingEnabled(): boolean {
  try {
    return readFileSync(filePath("JEV_LOG_STATE_FILE", defaultStateFile), "utf8").trim() === "on";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Unable to read Jev logging state:", error instanceof Error ? error.message : String(error));
    }
    return false;
  }
}

export function setJevLoggingEnabled(enabled: boolean): void {
  const path = filePath("JEV_LOG_STATE_FILE", defaultStateFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, enabled ? "on\n" : "off\n", "utf8");
}

export function appendJevLog(record: Record<string, unknown>): void {
  try {
    if (!isJevLoggingEnabled()) return;
    const path = filePath("JEV_LOG_FILE", defaultLogFile);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch (error) {
    console.warn("Unable to write Jev log:", error instanceof Error ? error.message : String(error));
  }
}
