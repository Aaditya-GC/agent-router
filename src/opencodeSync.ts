// Shared logic: turn a Token Harbor catalog into accurate opencode model
// entries (context window, modalities). Used by both the router's
// POST /api/sync-models endpoint and the `npm run sync-models` CLI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CatalogModel {
  id: string;
  label?: string | null;
  context_length?: number;
  pricing?: Record<string, number> | null;
  supports_prompt_cache?: boolean;
  tool_call?: boolean;
}

export interface SyncOptions {
  catalog: CatalogModel[];
  configPath?: string;
  providerId?: string;
  baseURL?: string;
  /** conservative window for entries whose context_length is missing/zero */
  fallbackContext?: number;
  /**
   * Harbor's gateway rejects request bodies over ~1.6MB and misreports it as
   * `context_length_exceeded` (1.4MB/700K tokens passes, 1.56MB/429 tokens
   * fails). ~280K tokens of text is about 1.4MB, so capping the context keeps
   * text-heavy requests under the byte ceiling. Override with MAX_CONTEXT.
   */
  maxContext?: number;
  defaultOutput?: number;
  /** drop models Harbor no longer serves */
  prune?: boolean;
}

export interface SyncResult {
  path: string;
  providerId: string;
  total: number;
  added: number;
  updated: number;
  fallback: number;
  clamped: number;
  removed: string[];
  error?: string;
}

export function defaultConfigPath(): string {
  return (
    process.env.OPENCODE_CONFIG ||
    path.join(os.homedir(), ".config", "opencode", "opencode.json")
  );
}

export function syncOpencodeModels(opts: SyncOptions): SyncResult {
  const configPath = opts.configPath || defaultConfigPath();
  const providerId = opts.providerId || process.env.PROVIDER_ID || "token-harbor-router";
  const baseURL = opts.baseURL || "http://localhost:4000/v1";
  const FALLBACK = opts.fallbackContext ?? (Number(process.env.FALLBACK_CONTEXT) || 128000);
  const MAX = opts.maxContext ?? (Number(process.env.MAX_CONTEXT) || 280000);
  const OUT = opts.defaultOutput ?? 8192;
  const prune = opts.prune !== false;

  const result: SyncResult = {
    path: configPath,
    providerId,
    total: opts.catalog.length,
    added: 0,
    updated: 0,
    fallback: 0,
    clamped: 0,
    removed: [],
  };

  if (!fs.existsSync(configPath)) {
    result.error = `no opencode config at ${configPath}`;
    return result;
  }
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    result.error = `${configPath} is not plain JSON (comments/JSONC) — edit it manually`;
    return result;
  }

  cfg.provider ??= {};
  cfg.provider[providerId] ??= {
    npm: "@ai-sdk/openai-compatible",
    name: "Token Harbor (router)",
    options: { baseURL },
  };
  cfg.provider[providerId].options ??= {};
  cfg.provider[providerId].options.baseURL ??= baseURL;
  const provider = cfg.provider[providerId];
  provider.models ??= {};

  const catalogIds = new Set<string>();
  for (const m of opts.catalog) {
    const id = m?.id;
    if (!id) continue;
    catalogIds.add(id);
    const realCtx = Number(m.context_length);
    const usable = Number.isFinite(realCtx) && realCtx > 0;
    const advertised = usable ? realCtx : FALLBACK;
    const ctx = Math.min(advertised, MAX);
    if (!usable) result.fallback++;
    if (usable && realCtx > MAX) result.clamped++;

    const entry = provider.models[id];
    if (!entry) {
      provider.models[id] = {
        name: m.label || id,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: ctx, output: Math.min(ctx, OUT) },
      };
      result.added++;
      continue;
    }
    let changed = false;
    if (!entry.name) {
      entry.name = m.label || id;
      changed = true;
    }
    // Never overwrite a hand-tuned limit with the guessed fallback.
    const currentIsFallback = entry.limit?.context === FALLBACK;
    if (!usable && entry.limit?.context && !currentIsFallback) {
      // keep the human's number
    } else if (entry.limit?.context !== ctx) {
      entry.limit ??= {};
      entry.limit.context = ctx;
      if (!entry.limit.output) entry.limit.output = Math.min(ctx, OUT);
      changed = true;
    }
    if (changed) result.updated++;
  }

  if (prune) {
    for (const id of Object.keys(provider.models)) {
      if (!catalogIds.has(id)) {
        delete provider.models[id];
        result.removed.push(id);
      }
    }
  }

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return result;
}