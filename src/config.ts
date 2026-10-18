import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface JevConfig {
  platform?: string;
  localPort?: number;
  /** Full URL of a self-hosted Jev endpoint, spoken to with the direct `{model, state, questions}` contract. */
  customEndpoint?: string;
  /** Model id for the custom endpoint when JEV_CUSTOM_MODEL and JEV_MODEL are both unset. */
  customModel?: string;
  logging?: boolean;
}

export function configPath(): string {
  const override = process.env.JEV_CONFIG_FILE?.trim();
  if (!override) return path.join(os.homedir(), ".pi", "agent", "pi-jev-core.json");
  const resolved = path.resolve(override);
  // An override must not silently redirect persisted agent settings at a directory or a device file.
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isFile()) {
    throw new Error(`JEV_CONFIG_FILE must point at a regular file: ${resolved}`);
  }
  return resolved;
}

/** Error text for the user-facing throws below. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A `JSON.parse` failure embeds file content in its message, so logs name the code and never the message. */
function errorReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown error";
}


/** A custom endpoint must be an absolute http(s) URL; anything else is not something we can post to. */
export function validEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!URL.canParse(trimmed)) return null;
  const protocol = new URL(trimmed).protocol;
  return protocol === "http:" || protocol === "https:" ? trimmed : null;
}
/**
 * Create the parent directory and swap `data` into `file` in one step: readers never see a partial file, and a crash
 * mid-write leaves the previous content intact. The temp name carries a UUID, so concurrent writers — including
 * worker threads, which share a pid — never collide.
 */
export function writeFileAtomic(file: string, data: string, mode: number): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tmp, data, { encoding: "utf8", mode });
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Keep the original error: a failed cleanup must not mask why the write failed.
    }
    throw error;
  }
}

/** Keep only the fields we understand, with the type we expect: a hand-edited config never reaches callers as a wrong type. */
function pickConfig(value: unknown): JevConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const config: JevConfig = {};
  if (typeof raw.platform === "string") config.platform = raw.platform;
  // A hand-edited port outside the socket range would otherwise fail much later, at bind time.
  if (
    typeof raw.localPort === "number" &&
    Number.isInteger(raw.localPort) &&
    raw.localPort >= 1 &&
    raw.localPort <= 65535
  ) {
    config.localPort = raw.localPort;
  }
  if (typeof raw.logging === "boolean") config.logging = raw.logging;
  const endpoint = validEndpoint(raw.customEndpoint);
  if (endpoint) config.customEndpoint = endpoint;
  const customModel = typeof raw.customModel === "string" ? raw.customModel.trim() : "";
  if (customModel) config.customModel = customModel;
  return config;
}

/** Strict raw read: an existing but unreadable config throws, so writers can refuse to overwrite it. */
function readConfigFile(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function readConfig(): JevConfig {
  try {
    return pickConfig(readConfigFile());
  } catch (error) {
    // Deliberate: settings must never break an evaluation. The caller gets defaults, the user gets the reason.
    console.warn("Unable to read pi-jev-core config:", errorReason(error));
    return {};
  }
}

export function updateConfig(update: Partial<JevConfig>): void {
  const file = configPath();
  let existing: Record<string, unknown>;
  try {
    existing = readConfigFile();
  } catch (error) {
    throw new Error(`Refusing to overwrite unreadable ${file}: ${errorMessage(error)}`);
  }

  // Keys this version does not know about survive a rewrite, but the fields this module owns are re-validated:
  // an update carrying `undefined` must not silently delete a stored value.
  const merged = { ...existing, ...pickConfig({ ...existing, ...update }) };
  try {
    writeFileAtomic(file, JSON.stringify(merged, null, 2) + "\n", 0o600);
  } catch (error) {
    throw new Error(`Unable to write ${file}: ${errorMessage(error)}`);
  }
}
