import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Strategy = "round-robin" | "failover" | "least-errors";

export interface KeyEntry {
  id: string;
  alias: string;
  /** encrypted at rest (enc:... / b64:...) — never sent to dashboard */
  secret: string;
  enabled: boolean;
  createdAt: number;
  // runtime health (persisted so cooldowns survive restarts)
  cooldownUntil: number;
  consecutiveFailures: number;
  successCount: number;
  errorCount: number;
  lastError: string | null;
  /** machine-readable upstream error code (invalid_api_key, email_not_verified…) */
  lastErrorCode: string | null;
  lastUsed: number | null;
  lastSuccess: number | null;
  lastModel: string | null;
  invalid: boolean;
  // cumulative usage (tokens may be absent pre-streaming-sniff)
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  tokensCached: number;
  /** requests served per day, "YYYY-MM-DD" → count (pruned to ~14 days) */
  daily: Record<string, number>;
}

/** Per-model rollup across all keys, for the health and cost panels. */
export interface ModelStat {
  ok: number;
  err: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  tokensCached: number;
  lastUsed: number | null;
  lastStatus: number | null;
  lastError: string | null;
}

export interface DbShape {
  keys: KeyEntry[];
  models: Record<string, ModelStat>;
  strategy: Strategy;
  totalRequests: number;
  totalErrors: number;
  /** per-key daily request target used by the allowance burn-down */
  allowanceTarget: number;
  /** model ids known at the last opencode sync, for drift detection */
  catalog: { ids: string[]; fetchedAt: number } | null;
  /** cumulative images dropped to keep requests under the upstream byte limit */
  trimmedImages: number;
}

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

function getSecret(): string | null {
  return process.env.ROUTER_SECRET?.trim() ? process.env.ROUTER_SECRET.trim() : null;
}

// --- at-rest encryption (AES-GCM when ROUTER_SECRET set, else base64 obfuscation) ---
export function encryptKey(plain: string): string {
  const secret = getSecret();
  if (!secret) return "b64:" + Buffer.from(plain, "utf8").toString("base64");
  const key = crypto.scryptSync(secret, "agent-router-salt", 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptKey(stored: string): string {
  if (stored.startsWith("b64:")) {
    return Buffer.from(stored.slice(4), "base64").toString("utf8");
  }
  if (stored.startsWith("enc:")) {
    const secret = getSecret();
    if (!secret) throw new Error("ROUTER_SECRET is required to decrypt stored keys");
    const [, ivHex, tagHex, dataHex] = stored.split(":");
    const key = crypto.scryptSync(secret, "agent-router-salt", 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(dataHex, "hex")).toString("utf8") + decipher.final("utf8");
  }
  // legacy plaintext fallback
  return stored;
}

export function maskKey(stored: string): string {
  try {
    const plain = decryptKey(stored);
    if (plain.length <= 8) return "••••";
    return plain.slice(0, 4) + "••••" + plain.slice(-4);
  } catch {
    return "(undecryptable — set ROUTER_SECRET)";
  }
}

function defaultDb(): DbShape {
  return {
    keys: [],
    models: {},
    strategy: (process.env.STRATEGY as Strategy) || "round-robin",
    totalRequests: 0,
    totalErrors: 0,
    allowanceTarget: Number(process.env.ALLOWANCE_TARGET) || 150,
    catalog: null,
    trimmedImages: 0,
  };
}

export function loadDb(): DbShape {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) return defaultDb();
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    const db = { ...defaultDb(), ...raw };
    // normalize older entries missing newer fields
    if (Array.isArray((db as any).keys)) {
      for (const k of (db as any).keys) {
        k.tokensIn ??= 0;
        k.tokensOut ??= 0;
        k.tokensTotal ??= 0;
        k.tokensCached ??= 0;
        k.lastModel ??= null;
        k.lastErrorCode ??= null;
        // Backfill the code for errors recorded before we started storing it.
        if (!k.lastErrorCode && typeof k.lastError === "string") {
          const m =
            k.lastError.match(/"code"\s*:\s*"([a-z0-9_]+)"/i) ||
            k.lastError.match(/"type"\s*:\s*"([a-z0-9_]+)"/i);
          if (m) k.lastErrorCode = m[1];
        }
        k.invalid ??= false;
        k.daily ??= {};
      }
    }
    db.models ??= {};
    db.allowanceTarget ??= 150;
    db.catalog ??= null;
    db.trimmedImages ??= 0;
    return db;
  } catch {
    return defaultDb();
  }
}

let saveTimer: NodeJS.Timeout | null = null;
export function saveDb(db: DbShape): void {
  // debounced write — proxy hot path calls this a lot
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
    } catch {
      // non-fatal
    }
  }, 500);
}

export function saveDbNow(db: DbShape): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch {
    // non-fatal
  }
}
