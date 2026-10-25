import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import path from "node:path";
import {
  decryptKey,
  encryptKey,
  loadDb,
  maskKey,
  saveDb,
  saveDbNow,
  type KeyEntry,
  type ModelStat,
  type Strategy,
} from "./store.js";
import { syncOpencodeModels } from "./opencodeSync.js";

const PORT = Number(process.env.PORT || 4000);
const UPSTREAM = (process.env.UPSTREAM_BASE_URL || "https://tokenharbor.ai/v1").replace(/\/$/, "");
const ROUTER_API_KEY = process.env.ROUTER_API_KEY?.trim() || "";
// Harbor's gateway rejects request bodies above ~1.6MB with a misleading
// `context_length_exceeded` error. Stay comfortably under it.
const MAX_REQUEST_BYTES = Number(process.env.MAX_REQUEST_BYTES) || 1_500_000;

const db = loadDb();
let rrIndex = 0;

// Bulk seed: HARBOR_KEYS env (comma/newline separated) + data/keys.txt
// (one per line, `alias=key` or bare key, # = comment).
// Placeholder values (PASTE_*, YOUR_KEY, CHANGE_ME, xxx) are skipped.
function seedKeysFromSources(): void {
  const chunks: string[] = [];
  if (process.env.HARBOR_KEYS?.trim()) chunks.push(process.env.HARBOR_KEYS);
  try {
    const f = path.join(process.cwd(), "data", "keys.txt");
    if (fs.existsSync(f)) chunks.push(fs.readFileSync(f, "utf8"));
  } catch {
    // optional file — ignore
  }
  if (chunks.length === 0) return;
  const isPlaceholder = (k: string): boolean =>
    /PASTE_|YOUR_KEY|CHANGE_ME|^x+$|^xxx/i.test(k);
  let added = 0;
  for (const chunk of chunks) {
    for (const rawLine of chunk.split(/[\r\n]+/)) {
      // strip comments FIRST (full-line or trailing " #..."), then split
      let line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const hash = line.indexOf(" #");
      if (hash !== -1) line = line.slice(0, hash).trim();
      if (!line) continue;
      for (const part of line.split(",")) {
        const key0 = part.trim();
        if (!key0) continue;
        let alias = "";
        let key = key0;
        const eq = key0.indexOf("=");
        // Only treat `left=right` as alias=key when the left side looks like
        // an alias — a bare key containing "=" (e.g. base64 padding) stays whole.
        if (eq > 0 && /^[\w-]{1,64}$/.test(key0.slice(0, eq).trim())) {
          alias = key0.slice(0, eq).trim();
          key = key0.slice(eq + 1).trim();
        }
        if (!key || isPlaceholder(key)) continue;
        if (!alias) {
          let n = db.keys.length + 1;
          while (db.keys.some((k) => k.alias === `harbor-${n}`)) n++;
          alias = `harbor-${n}`;
        }
        if (db.keys.some((k) => k.alias === alias)) continue;
        db.keys.push({
          id: crypto.randomUUID(),
          alias,
          secret: encryptKey(key),
          enabled: true,
          createdAt: Date.now(),
          cooldownUntil: 0,
          consecutiveFailures: 0,
          successCount: 0,
          errorCount: 0,
          lastError: null,
          lastErrorCode: null,
          lastUsed: null,
          lastSuccess: null,
          lastModel: null,
          invalid: false,
          tokensIn: 0,
          tokensOut: 0,
          tokensTotal: 0,
          tokensCached: 0,
          daily: {},
        });
        added++;
      }
    }
  }
  if (added > 0) {
    saveDbNow(db);
  }
}

interface LogLine {
  t: number;
  level: "info" | "warn" | "error";
  msg: string;
}
const logs: LogLine[] = [];
function log(level: LogLine["level"], msg: string): void {
  logs.push({ t: Date.now(), level, msg });
  if (logs.length > 300) logs.splice(0, logs.length - 300);
  if (level !== "info") console[level === "warn" ? "warn" : "error"](`[router] ${msg}`);
  else console.log(`[router] ${msg}`);
}

// ---------- key selection ----------

function healthyKeys(): KeyEntry[] {
  const now = Date.now();
  return db.keys.filter((k) => k.enabled && !k.invalid && k.cooldownUntil <= now);
}

function orderKeys(cands: KeyEntry[]): KeyEntry[] {
  const s: Strategy = db.strategy;
  if (s === "failover") return [...cands].sort((a, b) => a.createdAt - b.createdAt);
  if (s === "least-errors") {
    return [...cands].sort((a, b) => {
      const ar = a.errorCount / Math.max(1, a.successCount + a.errorCount);
      const br = b.errorCount / Math.max(1, b.successCount + b.errorCount);
      return ar - br || a.successCount - b.successCount;
    });
  }
  // round-robin: rotate starting point
  if (cands.length === 0) return cands;
  const start = rrIndex % cands.length;
  return [...cands.slice(start), ...cands.slice(0, start)];
}

function markSuccess(k: KeyEntry): void {
  k.successCount++;
  k.consecutiveFailures = 0;
  k.cooldownUntil = 0;
  k.lastSuccess = Date.now();
  k.lastUsed = Date.now();
  k.lastError = null;
  k.lastErrorCode = null;
}

/** Parse "retry in about 30 seconds" style hints out of gateway error bodies. */
function retryHintMs(text: string): number | null {
  const m = text.match(
    /retry(?:\s+again)?\s+in\s+(?:about\s+|~|approximately\s+)?(\d+)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)/i
  );
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = m[2].toLowerCase().startsWith("m") ? n * 60_000 : n * 1000;
  return Math.min(Math.max(ms, 3_000), 10 * 60_000);
}

/** Spread cooldowns so keys don't all come back at the same instant. */
function withJitter(ms: number): number {
  return Math.max(3_000, Math.round(ms * (0.85 + Math.random() * 0.3)));
}

/** Pull the machine-readable error code out of an upstream JSON error body. */
function extractErrorCode(text: string): string | null {
  const m =
    text.match(/"code"\s*:\s*"([a-z0-9_]+)"/i) || text.match(/"type"\s*:\s*"([a-z0-9_]+)"/i);
  return m ? m[1] : null;
}

function markFailure(k: KeyEntry, err: string, status?: number, cooldownMs?: number, code?: string | null): void {
  k.errorCount++;
  k.consecutiveFailures++;
  k.lastError = status ? `HTTP ${status}: ${err}` : err;
  if (code) k.lastErrorCode = code;
  k.lastUsed = Date.now();
  if (status === 401 || status === 403) {
    // Auth problems are account state, not transient load. But Harbor's auth
    // service has been observed returning `invalid_api_key` for perfectly good
    // keys during an outage (auth.tokenharbor.ai 525), so NEVER auto-mark a key
    // invalid — park it briefly and let the operator decide.
    const revoked = code === "invalid_api_key";
    const unverified = code === "email_not_verified";
    k.cooldownUntil = Date.now() + (unverified ? 5 * 60 * 1000 : 15 * 60 * 1000);
    const why = revoked
      ? "key revoked? (may be a Harbor auth outage)"
      : unverified
        ? "email unverified — retrying in 5m"
        : "auth error";
    log("warn", `${k.alias} got ${status} — parked ${unverified ? "5m" : "15m"} (${why})`);
  } else if (cooldownMs != null) {
    k.cooldownUntil = Date.now() + Math.min(cooldownMs, 10 * 60_000);
  } else {
    // 5xx and friends: start short, double on repeats, cap at 5 minutes.
    const backoff = Math.min(20_000 * 2 ** Math.min(k.consecutiveFailures - 1, 4), 5 * 60_000);
    k.cooldownUntil = Date.now() + withJitter(backoff);
  }
}

const RETRYABLE = new Set([429, 402, 500, 502, 503, 504]);

// Upstream usage schemas seen so far (logged once each for diagnostics).
const seenUsageShapes = new Set<string>();

interface ParsedUsage {
  inp: number;
  out: number;
  total: number;
  cached: number;
}

// Normalize an OpenAI/Anthropic usage payload into plain numbers.
function parseUsage(u: unknown): ParsedUsage | null {
  if (!u || typeof u !== "object") return null;
  const rec = u as Record<string, unknown>;
  const det =
    rec.prompt_tokens_details && typeof rec.prompt_tokens_details === "object"
      ? (rec.prompt_tokens_details as Record<string, unknown>)
      : null;
  // One-time diagnostic: reveal the upstream usage schema in the Log panel
  // so we can see e.g. whether Harbor reports prompt-cache fields.
  const shape =
    Object.keys(rec).sort().join(",") + (det ? "|details:" + Object.keys(det).sort().join(",") : "");
  if (!seenUsageShapes.has(shape)) {
    seenUsageShapes.add(shape);
    log("info", `upstream usage shape: ${shape || "(empty)"}`);
  }
  const pi = Number(rec.prompt_tokens);
  const co = Number(rec.completion_tokens);
  const to = Number(rec.total_tokens);
  const inp = Number.isFinite(pi) ? pi : 0;
  const out = Number.isFinite(co) ? co : 0;
  const total = Number.isFinite(to) ? to : inp + out;
  // Prompt-cache hits: OpenAI shape (prompt_tokens_details.cached_tokens),
  // top-level cached_tokens, or Anthropic cache_read_input_tokens.
  let cached = 0;
  const c1 = Number(det?.cached_tokens);
  const c2 = Number(rec.cached_tokens);
  const c3 = Number(rec.cache_read_input_tokens);
  if (Number.isFinite(c1)) cached = c1;
  else if (Number.isFinite(c2)) cached = c2;
  else if (Number.isFinite(c3)) cached = c3;
  return { inp, out, total, cached };
}

// Add an OpenAI-style usage payload to a key's cumulative counters.
function accumulateUsage(k: KeyEntry, u: unknown): void {
  const p = parseUsage(u);
  if (!p) return;
  k.tokensIn += p.inp;
  k.tokensOut += p.out;
  k.tokensTotal += p.total;
  k.tokensCached += p.cached;
}

function ensureModelStat(model: string): ModelStat {
  db.models[model] ??= {
    ok: 0,
    err: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    tokensCached: 0,
    lastUsed: null,
    lastStatus: null,
    lastError: null,
  };
  return db.models[model];
}

// Roll a usage payload into the per-model stats (feeds health + cost panels).
function accumulateModelUsage(model: string | null, u: unknown): void {
  if (!model) return;
  const p = parseUsage(u);
  const s = ensureModelStat(model);
  s.lastUsed = Date.now();
  if (!p) return;
  s.tokensIn += p.inp;
  s.tokensOut += p.out;
  s.tokensTotal += p.total;
  s.tokensCached += p.cached;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** YYYY-MM-DD for a timestamp (defaults to now). */
const dayKey = (ts: number = Date.now()): string => new Date(ts).toISOString().slice(0, 10);

// Bump a key's per-day request count and drop anything older than 14 days.
function bumpDaily(k: KeyEntry): void {
  const d = today();
  k.daily ??= {};
  k.daily[d] = (k.daily[d] || 0) + 1;
  const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  for (const day of Object.keys(k.daily)) {
    if (day < cutoff) delete k.daily[day];
  }
}

function lastNDaysCount(daily: Record<string, number> | undefined, n: number): number {
  if (!daily) return 0;
  const cutoff = new Date(Date.now() - (n - 1) * 86400_000).toISOString().slice(0, 10);
  let sum = 0;
  for (const [day, count] of Object.entries(daily)) {
    if (day >= cutoff) sum += count;
  }
  return sum;
}

// ---------- upstream catalog (models, pricing, cache support) ----------

interface UpstreamModel {
  id: string;
  label?: string | null;
  tier?: string | null;
  pricing?: Record<string, number> | null;
  supports_prompt_cache?: boolean;
  context_length?: number;
  tool_call?: boolean;
  blurb?: string | null;
}

let catalogCache: { t: number; data: UpstreamModel[] } = { t: 0, data: [] };

function isFreeModel(m: UpstreamModel): boolean {
  if (/:free$/i.test(m.id)) return true;
  const p = m.pricing ?? {};
  const inP = Number(p.input_usd_per_1m);
  const outP = Number(p.output_usd_per_1m);
  return Number.isFinite(inP) && Number.isFinite(outP) && inP === 0 && outP === 0;
}

async function upstreamCatalog(force = false): Promise<UpstreamModel[]> {
  if (!force && catalogCache.data.length && Date.now() - catalogCache.t < 300_000) {
    return catalogCache.data;
  }
  const key = orderKeys(healthyKeys())[0] ?? db.keys.find((k) => k.enabled && !k.invalid);
  if (!key) return catalogCache.data;
  try {
    const plain = decryptKey(key.secret);
    const r = await fetch(`${UPSTREAM}/models`, { headers: { Authorization: `Bearer ${plain}` } });
    if (!r.ok) return catalogCache.data;
    const j = (await r.json()) as { data?: UpstreamModel[] };
    if (Array.isArray(j.data) && j.data.length) {
      catalogCache = { t: Date.now(), data: j.data };
    }
    return catalogCache.data;
  } catch {
    return catalogCache.data;
  }
}

// ---------- cost estimation ----------

interface CostBreakdown {
  spend: number;
  savedByCache: number;
  freeTokens: number;
  unknown: boolean;
}

function estimateCost(catalog: UpstreamModel[]): CostBreakdown {
  const byId = new Map(catalog.map((m) => [m.id, m]));

  // Resolve a list price for a model. Free routes report $0 (they are billed
  // against an allowance), so value them at the paid sibling's published price
  // (the same id without `:free`) — i.e. what DeepSeek actually charges.
  const priceOf = (m?: UpstreamModel) => {
    if (!m?.pricing) return null;
    const inp = Number(m.pricing.input_usd_per_1m);
    const out = Number(m.pricing.output_usd_per_1m);
    const cr = Number(m.pricing.cache_read_usd_per_1m);
    if (!Number.isFinite(inp) || !Number.isFinite(out)) return null;
    return { inp, out, cacheRead: Number.isFinite(cr) ? cr : inp };
  };
  const resolvePrice = (id: string) => {
    const own = priceOf(byId.get(id));
    const zero = !own || (own.inp === 0 && own.out === 0);
    if (!zero) return { ...own!, free: false };
    const paidId = id.replace(/:free$/i, "");
    const paid = paidId !== id ? priceOf(byId.get(paidId)) : null;
    if (paid) return { ...paid, free: true };
    return own ? { ...own, free: true } : null;
  };

  // Usage recorded before per-model tracking lives only in the per-key totals.
  // Spread that remainder across models by their share so "cost so far" covers
  // everything, not just traffic seen since this panel existed.
  let keyIn = 0, keyOut = 0, keyCached = 0;
  for (const k of db.keys) {
    keyIn += k.tokensIn || 0;
    keyOut += k.tokensOut || 0;
    keyCached += k.tokensCached || 0;
  }
  let modelIn = 0, modelOut = 0, modelCached = 0;
  for (const s of Object.values(db.models)) {
    modelIn += s.tokensIn || 0;
    modelOut += s.tokensOut || 0;
    modelCached += s.tokensCached || 0;
  }
  const leftoverIn = Math.max(0, keyIn - modelIn);
  const leftoverOut = Math.max(0, keyOut - modelOut);
  const leftoverCached = Math.max(0, keyCached - modelCached);
  const shares = Object.values(db.models).reduce((a, s) => a + (s.tokensTotal || 0), 0);

  let spend = 0;
  let saved = 0;
  let freeTokens = 0;
  let unknown = false;

  for (const [id, s] of Object.entries(db.models)) {
    const p = resolvePrice(id);
    if (!p) {
      unknown = true;
      continue;
    }
    const share = shares > 0 ? (s.tokensTotal || 0) / shares : 0;
    const tin = s.tokensIn + leftoverIn * share;
    const tout = s.tokensOut + leftoverOut * share;
    const tcached = Math.min(s.tokensIn + leftoverCached * share, tin);
    const cached = Math.min(tcached, tin);
    const fresh = Math.max(0, tin - cached);
    const cost = (fresh / 1e6) * p.inp + (cached / 1e6) * p.cacheRead + (tout / 1e6) * p.out;
    const noCacheCost = (tin / 1e6) * p.inp + (tout / 1e6) * p.out;
    spend += cost;
    saved += Math.max(0, noCacheCost - cost);
    if (p.free) freeTokens += tin + tout;
  }

  return { spend, savedByCache: saved, freeTokens, unknown };
}

// Best-effort parse of a streamed SSE tail for a final {"usage":{...}} chunk.
function sniffStreamUsage(tail: string): Record<string, number> | null {
  const idx = tail.indexOf('"usage"');
  if (idx === -1) return null;
  const seg = tail.slice(idx, idx + 400);
  const num = (name: string): number | null => {
    const m = seg.match(new RegExp(`"${name}"\\s*:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const out: Record<string, number> = {};
  for (const n of ["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "cache_read_input_tokens"]) {
    const v = num(n);
    if (v !== null) out[n] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function cooldownMsForHumans(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

// ---------- request size guard ----------

interface ShrunkRequest {
  body: Record<string, unknown>;
  trimmed: number;
  model: string | null;
}

const IMAGE_PART_TYPES = new Set(["image_url", "input_image", "image"]);
// Left in place of a dropped image so the model knows it cannot see that view,
// instead of guessing from a stale memory of it.
const IMAGE_OMITTED = "[screenshot omitted to fit the upstream request-size limit]";

function isImagePart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const t = (part as Record<string, unknown>).type;
  return typeof t === "string" && IMAGE_PART_TYPES.has(t);
}

/**
 * Drop base64 image parts, oldest messages first, until the serialized request
 * fits the gateway's byte ceiling. Text, tools and recent images survive.
 */
function shrinkRequest(input: unknown): ShrunkRequest {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const model = typeof body.model === "string" ? body.model : null;
  let json = JSON.stringify(body);
  if (json.length <= MAX_REQUEST_BYTES) return { body, trimmed: 0, model };

  let clone: Record<string, unknown>;
  try {
    clone = structuredClone(body);
  } catch {
    clone = JSON.parse(json) as Record<string, unknown>;
  }
  const messages = Array.isArray(clone.messages) ? (clone.messages as any[]) : [];
  let trimmed = 0;

  for (const message of messages) {
    if (json.length <= MAX_REQUEST_BYTES) break;
    if (!message || !Array.isArray(message.content)) continue;
    // Drop images one at a time so a message with several still keeps as many
    // as fit under the ceiling.
    while (json.length > MAX_REQUEST_BYTES) {
      const idx = message.content.findIndex(isImagePart);
      if (idx === -1) break;
      // Replace rather than delete: the model gets told a view was dropped.
      message.content.splice(idx, 1, { type: "text", text: IMAGE_OMITTED });
      trimmed++;
      json = JSON.stringify(clone);
    }
  }

  return { body: clone, trimmed, model };
}

// ---------- proxy core ----------

async function forwardWithRotation(
  req: express.Request,
  res: express.Response,
  upstreamPath: string,
  method: string
): Promise<void> {
  const tried: string[] = [];
  let candidates = orderKeys(healthyKeys());

  // All keys cooling down? Be forgiving: try the one waking up soonest.
  if (candidates.length === 0 && db.keys.some((k) => k.enabled && !k.invalid)) {
    const soonest = [...db.keys]
      .filter((k) => k.enabled && !k.invalid)
      .sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
    const wait = Math.max(0, soonest.cooldownUntil - Date.now());
    if (wait > 30_000) {
      res.status(429).json({
        error: {
          message: `All keys cooling down. Soonest available: ${soonest.alias} in ${cooldownMsForHumans(wait)}`,
          type: "rate_limit",
          tried,
        },
      });
      return;
    }
    candidates = [soonest];
  }

  if (candidates.length === 0) {
    res.status(503).json({
      error: {
        message: "No enabled keys. Add a Token Harbor key in the dashboard (GET /).",
        type: "no_keys",
      },
    });
    return;
  }

  // Harbor rejects bodies over ~1.6MB and reports it as `context_length_exceeded`
  // (verified: 1.4MB/700K tokens passes, 1.56MB/429 tokens fails). Images account
  // for most of the bytes because they're base64, so drop the oldest ones until
  // the request fits. Recent images are preserved; text is never touched.
  const prepared = shrinkRequest(req.body ?? {});
  if (prepared.trimmed > 0) {
    db.trimmedImages = (db.trimmedImages || 0) + prepared.trimmed;
    log(
      "warn",
      `trimmed ${prepared.trimmed} image(s) from the oldest messages to keep the request under ` +
        `${Math.round(MAX_REQUEST_BYTES / 1024)}KB (model=${prepared.model ?? "?"})`
    );
  }
  const incomingBody =
    method === "GET" || method === "HEAD" ? undefined : JSON.stringify(prepared.body);
  const reqModel = prepared.model;
  let lastStatus = 502;
  let lastErrText = "unknown";

  for (const key of candidates) {
    tried.push(key.alias);
    let plain: string;
    try {
      plain = decryptKey(key.secret);
    } catch (e) {
      markFailure(key, "decrypt failed — set ROUTER_SECRET");
      continue;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    let upstream: Response;
    try {
      upstream = await fetch(`${UPSTREAM}${upstreamPath}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${plain}`,
        },
        body: incomingBody,
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      markFailure(key, `network: ${msg}`);
      log("warn", `${key.alias} network error: ${msg} — trying next key`);
      lastErrText = msg;
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (upstream.ok) {
      markSuccess(key);
      if (reqModel) key.lastModel = reqModel;
      bumpDaily(key);
      if (reqModel) {
        const ms = ensureModelStat(reqModel);
        ms.ok++;
        ms.lastUsed = Date.now();
        ms.lastStatus = upstream.status;
        ms.lastError = null;
      }
      rrIndex++;
      db.totalRequests++;
      saveDb(db);
      log("info", `${method} ${upstreamPath} → ${key.alias} (${upstream.status})`);

      // Pass through status + content-type (SSE streams included).
      res.status(upstream.status);
      const ct = upstream.headers.get("content-type");
      if (ct) res.setHeader("content-type", ct);

      if (!upstream.body) {
        res.end();
        return;
      }

      const isStream = ct?.includes("text/event-stream") || (req.body as any)?.stream === true;
      if (!isStream) {
        // Non-streaming: capture usage for stats, then forward.
        const text = await upstream.text();
        try {
          const usage = (JSON.parse(text) as any)?.usage;
          accumulateUsage(key, usage);
          accumulateModelUsage(reqModel, usage);
        } catch {
          // not JSON — fine, just forward
        }
        res.send(text);
        return;
      }

      // Streaming: pipe bytes through, tap `usage` chunks if provider sends them.
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let tail = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
          // best-effort usage sniff (OpenAI sends a final chunk with "usage")
          tail += decoder.decode(value, { stream: true });
          const sniffed = sniffStreamUsage(tail);
          if (sniffed) {
            accumulateUsage(key, sniffed);
            accumulateModelUsage(reqModel, sniffed);
            tail = tail.slice(-200);
          }
          if (tail.length > 4000) tail = tail.slice(-2000);
        }
      } catch {
        // client disconnected mid-stream — not a key failure
      }
      res.end();
      return;
    }

    // Non-2xx from upstream
    lastStatus = upstream.status;
    lastErrText = await upstream.text().catch(() => upstream.statusText);
    if (lastErrText.length > 500) lastErrText = lastErrText.slice(0, 500);

    if (RETRYABLE.has(upstream.status)) {
      const header = upstream.headers.get("retry-after");
      const headerSecs = header !== null ? Number(header) : NaN;
      // Harbor puts the useful hint in the body ("retry in about 30 seconds"),
      // not in a retry-after header. Respect it instead of guessing 60s+.
      const hint = retryHintMs(lastErrText);
      const backoffFallback = Math.min(
        20_000 * 2 ** Math.min(key.consecutiveFailures, 4),
        5 * 60_000
      );
      const waitMs = withJitter(
        Number.isFinite(headerSecs) && headerSecs > 0
          ? headerSecs * 1000
          : hint ?? backoffFallback
      );
      markFailure(key, lastErrText.slice(0, 200), upstream.status, waitMs);
      saveDb(db);
      log(
        "warn",
        `${key.alias} → ${upstream.status}, cooling ${Math.round(waitMs / 1000)}s, trying next key ` +
          `(${tried.length}/${candidates.length})`
      );
      continue;
    }

    if (upstream.status === 401 || upstream.status === 403) {
      markFailure(
        key,
        lastErrText.slice(0, 200),
        upstream.status,
        undefined,
        extractErrorCode(lastErrText)
      );
      saveDb(db);
      continue; // try next key — one bad key shouldn't fail the request
    }

    // Real client error (400/404/422...) — same for every key, forward as-is.
    db.totalErrors++;
    if (reqModel) {
      const ms = ensureModelStat(reqModel);
      ms.err++;
      ms.lastUsed = Date.now();
      ms.lastStatus = upstream.status;
      ms.lastError = lastErrText.slice(0, 200);
    }
    saveDb(db);
    const approxTokens = incomingBody ? Math.round(incomingBody.length / 4) : 0;
    log(
      "warn",
      `${method} ${upstreamPath} → ${key.alias} client error ${upstream.status} ` +
        `[model=${reqModel ?? "?"} bytes=${incomingBody?.length ?? 0} ~${approxTokens} tok]: ` +
        lastErrText.slice(0, 300)
    );
    // Dump the offending request so oversized payloads can be inspected locally.
    if (incomingBody) {
      try {
        fs.writeFileSync(path.join(process.cwd(), "data", "last-error-request.json"), incomingBody, "utf8");
      } catch {
        // non-fatal
      }
    }
    // Break the payload down (chars vs tokens diverge wildly when images are
    // embedded as base64, which inflates the upstream token count invisibly).
    if (incomingBody) {
      try {
        const req = JSON.parse(incomingBody);
        const msgs = Array.isArray(req.messages) ? req.messages : [];
        let imgCount = 0;
        let imgChars = 0;
        for (const m of msgs) {
          const parts = Array.isArray(m?.content) ? m.content : [];
          for (const p of parts) {
            const url = p?.image_url?.url;
            if (typeof url === "string") {
              imgCount++;
              imgChars += url.length;
            }
          }
        }
        const tools = Array.isArray(req.tools) ? req.tools : [];
        log(
          "warn",
          `  payload breakdown: messages=${msgs.length} tools=${tools.length} ` +
            `images=${imgCount} imageBase64Chars=${imgChars} ` +
            `(~${Math.round(imgChars / 4)} tok if counted by chars)`
        );
      } catch {
        // non-JSON body — skip breakdown
      }
    }
    res.status(upstream.status).type("application/json").send(lastErrText);
    return;
  }

  // Every key failed.
  db.totalRequests++;
  db.totalErrors++;
  if (reqModel) {
    const ms = ensureModelStat(reqModel);
    ms.err++;
    ms.lastUsed = Date.now();
    ms.lastStatus = lastStatus;
    ms.lastError = lastErrText.slice(0, 200);
  }
  saveDb(db);
  // If upstream was rate limiting, surface that as 429 (with retry-after) so
  // clients back off properly instead of treating it as a server failure.
  const enabled = db.keys.filter((k) => k.enabled && !k.invalid);
  const soonest = enabled.length ? Math.min(...enabled.map((k) => k.cooldownUntil)) : Date.now();
  const waitSecs = Math.max(1, Math.ceil((soonest - Date.now()) / 1000));
  const status = lastStatus === 429 || lastStatus === 402 ? 429 : 502;
  if (status === 429) res.setHeader("retry-after", String(Math.min(waitSecs, 600)));
  log(
    status === 429 ? "warn" : "error",
    `${method} ${upstreamPath} — all ${tried.length} keys failed. last: ${lastStatus}`
  );
  res.status(status).json({
    error: {
      message: `All upstream keys failed (tried: ${tried.join(", ") || "none"}). Last: HTTP ${lastStatus} ${lastErrText.slice(0, 200)}`,
      type: status === 429 ? "rate_limit" : "all_keys_failed",
      tried,
      lastStatus,
      retryAfter: status === 429 ? waitSecs : undefined,
    },
  });
}

// ---------- app ----------

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
// dashboard static
app.use(express.static(path.join(process.cwd(), "public")));

function routerAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!ROUTER_API_KEY) {
    next();
    return;
  }
  const header = req.header("x-router-key") || req.header("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim();
  // constant-time-ish compare
  const ok =
    token.length === ROUTER_API_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ROUTER_API_KEY));
  if (!ok) {
    res.status(401).json({ error: { message: "Invalid router key (set x-router-key or Bearer ROUTER_API_KEY)", type: "auth" } });
    return;
  }
  next();
}

app.get("/health", (_req, res) => {
  const now = Date.now();
  const enabled = db.keys.filter((k) => k.enabled && !k.invalid);
  const available = enabled.filter((k) => k.cooldownUntil <= now);
  const soonest = [...enabled].sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
  const tokensIn = db.keys.reduce((a, k) => a + (k.tokensIn || 0), 0);
  const tokensCached = db.keys.reduce((a, k) => a + (k.tokensCached || 0), 0);
  res.json({
    ok: true,
    upstream: UPSTREAM,
    strategy: db.strategy,
    keysTotal: db.keys.length,
    keysAvailable: available.length,
    keysEnabled: enabled.length,
    allCooling: enabled.length > 0 && available.length === 0,
    soonestEta: enabled.length > 0 && available.length === 0 && soonest
      ? Math.max(0, Math.ceil((soonest.cooldownUntil - now) / 1000))
      : 0,
    soonestAlias: soonest?.alias ?? null,
    cacheHitRate: tokensIn > 0 ? tokensCached / tokensIn : 0,
    totalRequests: db.totalRequests,
    totalErrors: db.totalErrors,
    trimmedImages: db.trimmedImages || 0,
    routerAuth: Boolean(ROUTER_API_KEY),
    encryptedAtRest: Boolean(process.env.ROUTER_SECRET),
  });
});

// --- OpenAI-compatible passthrough (rotation happens inside) ---
app.get("/v1/models", routerAuth, async (req, res) => {
  // cheap cache so model pickers don't burn keys
  const now = Date.now();
  if (modelCache.data && now - modelCache.t < 60_000) {
    res.json(modelCache.data);
    return;
  }
  // capture response by temporarily hooking res.json
  const origJson = res.json.bind(res);
  (res as any).json = (body: unknown) => {
    modelCache = { t: Date.now(), data: body };
    return origJson(body);
  };
  await forwardWithRotation(req, res, "/models", "GET");
});
let modelCache: { t: number; data: unknown } = { t: 0, data: null };

app.post("/v1/chat/completions", routerAuth, (req, res) => forwardWithRotation(req, res, "/chat/completions", "POST"));
app.post("/v1/completions", routerAuth, (req, res) => forwardWithRotation(req, res, "/completions", "POST"));
app.post("/v1/embeddings", routerAuth, (req, res) => forwardWithRotation(req, res, "/embeddings", "POST"));
app.post("/v1/responses", routerAuth, (req, res) => forwardWithRotation(req, res, "/responses", "POST"));

// --- admin API ---
app.get("/api/config", routerAuth, (_req, res) => {
  res.json({
    upstream: UPSTREAM,
    strategy: db.strategy,
    port: PORT,
    routerAuth: Boolean(ROUTER_API_KEY),
    encryptedAtRest: Boolean(process.env.ROUTER_SECRET),
  });
});

app.put("/api/config", routerAuth, (req, res) => {
  const s = req.body?.strategy as Strategy;
  if (!["round-robin", "failover", "least-errors"].includes(s)) {
    res.status(400).json({ error: "strategy must be round-robin | failover | least-errors" });
    return;
  }
  db.strategy = s;
  modelCache.t = 0;
  saveDbNow(db);
  log("info", `strategy → ${s}`);
  res.json({ ok: true, strategy: s });
});

app.get("/api/keys", routerAuth, (_req, res) => {
  const now = Date.now();
  res.json({
    keys: db.keys.map((k) => {
      // Personal local tool: dashboard shows full key values for copy/edit.
      let fullKey: string | null = null;
      let keyError = false;
      try {
        fullKey = decryptKey(k.secret);
      } catch {
        keyError = true;
      }
      return {
        id: k.id,
        alias: k.alias,
        key: fullKey,
        keyError,
        masked: maskKey(k.secret),
        enabled: k.enabled,
        invalid: k.invalid,
        cooling: k.cooldownUntil > now,
        cooldownSecs: Math.max(0, Math.ceil((k.cooldownUntil - now) / 1000)),
        successCount: k.successCount,
        errorCount: k.errorCount,
        consecutiveFailures: k.consecutiveFailures,
        lastError: k.lastError,
        lastErrorCode: k.lastErrorCode ?? null,
        lastUsed: k.lastUsed,
        lastSuccess: k.lastSuccess,
        lastModel: k.lastModel ?? null,
        tokensIn: k.tokensIn ?? 0,
        tokensOut: k.tokensOut ?? 0,
        tokensTotal: k.tokensTotal ?? 0,
        tokensCached: k.tokensCached ?? 0,
        createdAt: k.createdAt,
      };
    }),
  });
});

app.post("/api/keys", routerAuth, (req, res) => {
  const alias = String(req.body?.alias || "").trim();
  const key = String(req.body?.key || "").trim();
  if (!alias || !key) {
    res.status(400).json({ error: "alias and key are required" });
    return;
  }
  if (db.keys.some((k) => k.alias === alias)) {
    res.status(400).json({ error: "alias already exists" });
    return;
  }
  const entry: KeyEntry = {
    id: crypto.randomUUID(),
    alias,
    secret: encryptKey(key),
    enabled: true,
    createdAt: Date.now(),
    cooldownUntil: 0,
    consecutiveFailures: 0,
    successCount: 0,
    errorCount: 0,
    lastError: null,
    lastErrorCode: null,
    lastUsed: null,
    lastSuccess: null,
    lastModel: null,
    invalid: false,
tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    tokensCached: 0,
    daily: {},
  };
  db.keys.push(entry);
  saveDbNow(db);
  log("info", `key added: ${alias}`);
  res.json({ ok: true, id: entry.id });
});

app.patch("/api/keys/:id", routerAuth, (req, res) => {
  const k = db.keys.find((x) => x.id === req.params.id);
  if (!k) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (typeof req.body?.enabled === "boolean") k.enabled = req.body.enabled;
  if (typeof req.body?.alias === "string" && req.body.alias.trim()) k.alias = req.body.alias.trim();
  if (typeof req.body?.key === "string" && req.body.key.trim()) {
    // New secret: re-encrypt and revive health so the fresh key is tried immediately.
    k.secret = encryptKey(req.body.key.trim());
    k.cooldownUntil = 0;
    k.consecutiveFailures = 0;
    k.invalid = false;
    k.lastError = null;
  }
  if (req.body?.reset === true) {
    k.cooldownUntil = 0;
    k.consecutiveFailures = 0;
    k.invalid = false;
    k.lastError = null;
  }
  saveDbNow(db);
  res.json({ ok: true });
});

app.delete("/api/keys/:id", routerAuth, (req, res) => {
  const i = db.keys.findIndex((x) => x.id === req.params.id);
  if (i === -1) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const [rm] = db.keys.splice(i, 1);
  saveDbNow(db);
  log("info", `key removed: ${rm.alias}`);
  res.json({ ok: true });
});

app.post("/api/keys/:id/test", routerAuth, async (req, res) => {
  const k = db.keys.find((x) => x.id === req.params.id);
  if (!k) {
    res.status(404).json({ error: "not found" });
    return;
  }
  let plain: string;
  try {
    plain = decryptKey(k.secret);
  } catch {
    res.status(400).json({ ok: false, error: "cannot decrypt — set ROUTER_SECRET" });
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(`${UPSTREAM}/models`, {
      headers: { Authorization: `Bearer ${plain}` },
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (r.ok) {
      let count: number | null = null;
      try {
        count = (JSON.parse(text) as any)?.data?.length ?? null;
      } catch {
        // ignore
      }
      res.json({ ok: true, status: r.status, models: count });
    } else {
      res.json({ ok: false, status: r.status, error: text.slice(0, 300) });
    }
  } catch (e) {
    res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
});

app.get("/api/stats", routerAuth, async (_req, res) => {
  const now = Date.now();
  const sum = (f: (k: KeyEntry) => number): number =>
    db.keys.reduce((a, k) => a + (f(k) || 0), 0);
  const tokensIn = sum((k) => k.tokensIn ?? 0);
  const tokensCached = sum((k) => k.tokensCached ?? 0);
  const catalog = await upstreamCatalog();
  const cost = estimateCost(catalog);
  res.json({
    totalRequests: db.totalRequests,
    totalErrors: db.totalErrors,
    trimmedImages: db.trimmedImages || 0,
    tokensIn,
    tokensOut: sum((k) => k.tokensOut ?? 0),
    tokensTotal: sum((k) => k.tokensTotal ?? 0),
    tokensCached,
    cacheHitRate: tokensIn > 0 ? tokensCached / tokensIn : 0,
    cost: {
      spendUsd: cost.spend,
      savedByCacheUsd: cost.savedByCache,
      freeTokens: cost.freeTokens,
      pricingUnknown: cost.unknown,
      pricingBasis: "list price (paid route for free models)",
    },
    keysTotal: db.keys.length,
    keysAvailable: db.keys.filter((k) => k.enabled && !k.invalid && k.cooldownUntil <= now).length,
    perKey: db.keys.map((k) => ({
      alias: k.alias,
      success: k.successCount,
      errors: k.errorCount,
      tokensIn: k.tokensIn ?? 0,
      tokensOut: k.tokensOut ?? 0,
      tokensTotal: k.tokensTotal ?? 0,
      tokensCached: k.tokensCached ?? 0,
      lastModel: k.lastModel ?? null,
      lastUsed: k.lastUsed,
    })),
  });
});

// --- model catalog: free models, health, pricing ---
app.get("/api/models", routerAuth, async (req, res) => {
  const catalog = await upstreamCatalog(req.query.refresh === "1");
  const models = catalog
    .map((m) => {
      const stat = db.models[m.id];
      const p = m.pricing ?? {};
      return {
        id: m.id,
        label: m.label || m.id,
        free: isFreeModel(m),
        context: Number(m.context_length) || 0,
        cache: Boolean(m.supports_prompt_cache),
        toolCall: m.tool_call !== false,
        pricing: {
          input: Number(p.input_usd_per_1m) || 0,
          output: Number(p.output_usd_per_1m) || 0,
          cacheRead: Number(p.cache_read_usd_per_1m) || 0,
        },
        tier: m.tier ?? null,
        stat: stat
          ? {
              ok: stat.ok,
              err: stat.err,
              tokensTotal: stat.tokensTotal,
              tokensCached: stat.tokensCached,
              lastUsed: stat.lastUsed,
              lastStatus: stat.lastStatus,
              lastError: stat.lastError,
            }
          : null,
      };
    })
    .sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
  res.json({ models, fetchedAt: catalogCache.t || null });
});

// Probe models with a tiny request to learn which are alive right now.
app.post("/api/models/probe", routerAuth, async (req, res) => {
  const catalog = await upstreamCatalog(true);
  const freeOnly = req.body?.freeOnly !== false;
  let ids: string[] = Array.isArray(req.body?.ids) && req.body.ids.length
    ? req.body.ids.map(String)
    : catalog.filter((m) => (freeOnly ? isFreeModel(m) : true)).map((m) => m.id);
  const limit = Math.min(Number(req.body?.limit) || 6, 20);
  ids = ids.slice(0, limit);

  const key = orderKeys(healthyKeys())[0] ?? db.keys.find((k) => k.enabled && !k.invalid);
  if (!key) {
    res.status(503).json({ error: "no usable key to probe with" });
    return;
  }
  const plain = decryptKey(key.secret);
  const results: Array<{ id: string; ok: boolean; status: number; error?: string }> = [];

  for (const id of ids) {
    try {
      const r = await fetch(`${UPSTREAM}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plain}` },
        body: JSON.stringify({
          model: id,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      });
      const text = await r.text();
      const ok = r.ok;
      const ms = ensureModelStat(id);
      ms.lastStatus = r.status;
      ms.lastUsed = Date.now();
      if (ok) {
        ms.ok++;
        ms.lastError = null;
      } else {
        ms.err++;
        ms.lastError = text.slice(0, 200);
      }
      results.push({ id, ok, status: r.status, error: ok ? undefined : text.slice(0, 160) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const ms = ensureModelStat(id);
      ms.err++;
      ms.lastStatus = 0;
      ms.lastError = msg;
      results.push({ id, ok: false, status: 0, error: msg });
    }
  }
  saveDbNow(db);
  log("info", `probed ${results.length} model(s): ${results.filter((r) => r.ok).length} ok`);
  res.json({ results });
});

// --- allowance burn-down (requests served per key per day) ---
app.get("/api/allowance", routerAuth, (_req, res) => {
  res.json({
    target: db.allowanceTarget,
    keys: db.keys.map((k) => ({
      alias: k.alias,
      today: k.daily?.[dayKey()] || 0,
      last7d: Array.from({ length: 7 }, (_, i) => dayKey(Date.now() - i * 86_400_000)).reduce(
        (a, d) => a + (k.daily?.[d] || 0),
        0
      ),
      target: db.allowanceTarget,
    })),
  });
});

app.put("/api/allowance", routerAuth, (req, res) => {
  const t = Number(req.body?.target);
  if (!Number.isFinite(t) || t < 1 || t > 100000) {
    res.status(400).json({ error: "target must be a positive number" });
    return;
  }
  db.allowanceTarget = Math.round(t);
  saveDbNow(db);
  log("info", `allowance target → ${db.allowanceTarget}/day`);
  res.json({ ok: true, target: db.allowanceTarget });
});

// --- catalog drift + one-click opencode sync ---
app.get("/api/catalog/drift", routerAuth, async (_req, res) => {
  const catalog = await upstreamCatalog();
  const current = new Set(catalog.map((m) => m.id));
  const known = new Set(db.catalog?.ids ?? []);
  res.json({
    since: db.catalog?.fetchedAt ?? null,
    added: [...current].filter((id) => !known.has(id)),
    removed: [...known].filter((id) => !current.has(id)),
    total: catalog.length,
  });
});

app.post("/api/sync-models", routerAuth, async (_req, res) => {
  const catalog = await upstreamCatalog(true);
  if (!catalog.length) {
    res.status(503).json({ error: "could not fetch the upstream catalog" });
    return;
  }
  const result = syncOpencodeModels({
    catalog,
    baseURL: `http://localhost:${PORT}/v1`,
  });
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }
  db.catalog = { ids: catalog.map((m) => m.id), fetchedAt: Date.now() };
  saveDbNow(db);
  log(
    "info",
    `opencode sync: ${result.added} added, ${result.updated} updated, ${result.removed.length} pruned`
  );
  res.json(result);
});

app.get("/api/logs", routerAuth, (_req, res) => {
  res.json({ logs: logs.slice(-120).reverse() });
});

app.get("/api/opencode-snippet", routerAuth, (req, res) => {
  const host = req.get("host") || `localhost:${PORT}`;
  const proto = req.protocol || "http";
  res.json({
    snippet: {
      $schema: "https://opencode.ai/config.json",
      provider: {
        "token-harbor-router": {
          npm: "@ai-sdk/openai-compatible",
          name: "Token Harbor (router)",
          options: {
            baseURL: `${proto}://${host}/v1`,
            // Router password. File-based is most reliable on Windows
            // (env vars need fresh terminals): save ROUTER_API_KEY into
            // ~/.config/opencode/.router-key and reference it like this.
            apiKey: "{file:~/.config/opencode/.router-key}",
          },
          models: {
            "<harbor-model-id>": {
              name: "Pooled model (rename me)",
              modalities: { input: ["text", "image"], output: ["text"] },
              limit: { context: 128000, output: 8192 },
            },
          },
        },
      },
    },
    note: "Replace <harbor-model-id> with real IDs from GET /v1/models through this router. Set AGENT_ROUTER_KEY env var to your ROUTER_API_KEY value, then restart opencode and pick the model via /models.",
  });
});

process.on("SIGINT", () => {
  saveDbNow(db);
  process.exit(0);
});
process.on("SIGTERM", () => {
  saveDbNow(db);
  process.exit(0);
});

seedKeysFromSources();
if (db.keys.length > 0) log("info", `keys loaded: ${db.keys.length}`);

// Establish a catalog baseline so drift detection has something to compare to.
if (!db.catalog) {
  upstreamCatalog()
    .then((catalog) => {
      if (catalog.length) {
        db.catalog = { ids: catalog.map((m) => m.id), fetchedAt: Date.now() };
        saveDbNow(db);
      }
    })
    .catch(() => {
      // best effort — try again on the next dashboard request
    });
}

app.listen(PORT, () => {
  console.log(`[router] listening on http://localhost:${PORT}`);
  console.log(`[router] upstream: ${UPSTREAM} | strategy: ${db.strategy} | keys: ${db.keys.length}`);
  console.log(`[router] dashboard: http://localhost:${PORT}/`);
  if (!ROUTER_API_KEY) console.log("[router] ROUTER_API_KEY not set — router is open (localhost-only recommended)");
  if (!process.env.ROUTER_SECRET) console.log("[router] ROUTER_SECRET not set — keys stored obfuscated, not encrypted");
});
