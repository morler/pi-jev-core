import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { errorMessage, readConfig, updateConfig } from "./config.js";

const defaultLogFile = join(homedir(), ".pi", "agent", "jev-log.jsonl");

/** The log file's directory and permissions are settled on its first write; repeating them per record is pure syscalls. */
let preparedFile: string | null = null;
let permissionsFixedFor: string | null = null;

/** Bound one JSONL record: a huge state payload must not grow the log without limit. */
const MAX_RECORD_BYTES = 16_384;

function logFilePath(): string {
  return process.env.JEV_LOG_FILE?.trim() || defaultLogFile;
}

export function isJevLoggingEnabled(): boolean {
  // Read through: a cached flag hid manual edits to the config file, and the file is tiny.
  return readConfig().logging === true;
}

export function setJevLoggingEnabled(enabled: boolean): void {
  updateConfig({ logging: enabled });
}

export function appendJevLog(record: Record<string, unknown>): void {
  try {
    if (!isJevLoggingEnabled()) return;
    const file = logFilePath();
    if (preparedFile !== file) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      preparedFile = file;
    }
    appendFileSync(file, `${serialize(record)}\n`, { encoding: "utf8", mode: 0o600 });
    if (permissionsFixedFor !== file) {
      // `mode` only applies at creation, so an existing world-readable log needs one explicit fix-up.
      chmodSync(file, 0o600);
      permissionsFixedFor = file;
    }
  } catch (error) {
    console.warn("Unable to write Jev log:", errorMessage(error));
  }
}

/** Records carry full request/response payloads, so they are bounded and never lost to a serialization error. */
function serialize(record: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  try {
    const line = JSON.stringify({ ...record, timestamp });
    if (line.length <= MAX_RECORD_BYTES) return line;
    // shortcut: an oversize record leaves only a marker; upgrade to structured truncation if full audits matter.
    return JSON.stringify({ timestamp, type: record.type, truncated: true, bytes: line.length });
  } catch (error) {
    return JSON.stringify({ timestamp, type: record.type, unserializable: errorMessage(error) });
  }
}
