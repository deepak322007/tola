import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const analytics = require("../analytics.js");
const args = process.argv.slice(2);
const settlementFiles = [];
let activityFile = "";
let baseUrl = process.env.TOLA_URL || "http://localhost:3000";

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const value = args[index + 1];
  if (arg === "--settlements" && value) {
    settlementFiles.push(value);
    index += 1;
  } else if (arg === "--activity" && value) {
    activityFile = value;
    index += 1;
  } else if (arg === "--url" && value) {
    baseUrl = value;
    index += 1;
  } else {
    throw new Error(`Unknown argument "${arg}". Use --url, --settlements, and/or --activity.`);
  }
}

const token = process.env.TOLA_ADMIN_TOKEN;
if (!token) {
  throw new Error("Set TOLA_ADMIN_TOKEN to the secret configured on the server before importing");
}
if (settlementFiles.length === 0 && !activityFile) {
  throw new Error("Supply at least one --settlements <MCX CSV> or --activity <MCX detail report XLS>");
}

const origin = baseUrl.replace(/\/+$/, "");
const healthResponse = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(15000) });
if (!healthResponse.ok) throw new Error(`TOLA server returned HTTP ${healthResponse.status} at ${origin}`);
const health = await healthResponse.json();
console.log(`Connected to TOLA · current prices through ${health.settlements.through || "no data"} · activity through ${health.activity.through || "no data"}`);

async function post(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${result.error || "unknown server error"}`);
  console.log(`${path}: ${result.imported} records accepted · latest ${result.latest}`);
}

for (const filename of settlementFiles) {
  const path = resolve(filename);
  const csv = await readFile(path, "utf8");
  await post("/api/admin/import/settlements", { source: path, csv });
}

if (activityFile) {
  const path = resolve(activityFile);
  const report = await readFile(path, "utf8");
  const records = analytics.parseActivityReport(report);
  await post("/api/admin/import/activity", { source: path, records });
}
