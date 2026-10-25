// CLI: pull the live Token Harbor catalog through the router and rewrite
// opencode's model entries with accurate context windows.
//
//   npm run sync-models
import "dotenv/config";
import { syncOpencodeModels, defaultConfigPath } from "../src/opencodeSync.js";

const ROUTER_BASE = process.env.ROUTER_BASE_URL || "http://localhost:4000";
const ROUTER_KEY = process.env.ROUTER_API_KEY || "";

async function fetchCatalog() {
  const res = await fetch(`${ROUTER_BASE}/v1/models`, {
    headers: ROUTER_KEY ? { "x-router-key": ROUTER_KEY } : {},
  });
  if (!res.ok) {
    console.error(`sync-models: router returned HTTP ${res.status} (is it running? key correct?)`);
    process.exit(1);
  }
  const body = await res.json();
  const list = Array.isArray(body?.data) ? body.data : [];
  if (!list.length) {
    console.error("sync-models: catalog was empty");
    process.exit(1);
  }
  return list;
}

const catalog = await fetchCatalog();
const r = syncOpencodeModels({ catalog, configPath: defaultConfigPath() });

if (r.error) {
  console.error(`sync-models: ${r.error}`);
  process.exit(1);
}
console.log(
  `sync-models: catalog ${r.total} — ${r.added} added, ${r.updated} updated, ` +
    `${r.fallback} fallback window, ${r.clamped} clamped to the Harbor ceiling`
);
if (r.removed.length) {
  console.log(`sync-models: pruned ${r.removed.length} retired model(s): ${r.removed.join(", ")}`);
}
console.log(`sync-models: wrote ${r.path}`);
console.log("sync-models: restart opencode to pick up the changes.");