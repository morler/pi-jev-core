import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readConfig, updateConfig } from "./config.js";

const defaultLogFile = join(homedir(), ".pi", "agent", "jev-log.jsonl");

function logFilePath(): string {
  return process.env.JEV_LOG_FILE?.trim() || defaultLogFile;
}

export function isJevLoggingEnabled(): boolean {
  return readConfig().logging === true;
}

export function setJevLoggingEnabled(enabled: boolean): void {
  updateConfig({ logging: enabled });
}

export function appendJevLog(record: Record<string, unknown>): void {
  try {
    if (!isJevLoggingEnabled()) return;
    const file = logFilePath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch (error) {
    console.warn("Unable to write Jev log:", error instanceof Error ? error.message : String(error));
  }
}
