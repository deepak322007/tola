import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const analytics = require("./analytics.js");
const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
const ASSETS = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/analytics.js", "analytics.js"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"]
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function openDatabase(databasePath) {
  if (databasePath !== ":memory:") {
    mkdirSync(resolve(databasePath, ".."), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settlements (
      symbol TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      open REAL NOT NULL CHECK(open > 0),
      high REAL NOT NULL CHECK(high > 0),
      low REAL NOT NULL CHECK(low > 0),
      close REAL NOT NULL CHECK(close > 0),
      volume_lots INTEGER NOT NULL CHECK(volume_lots >= 0),
      open_interest_lots INTEGER NOT NULL CHECK(open_interest_lots >= 0),
      PRIMARY KEY(symbol, trade_date, expiry_date)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS settlements_by_date
      ON settlements(trade_date, symbol, expiry_date);
    CREATE TABLE IF NOT EXISTS activity (
      symbol TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      traded_lots INTEGER NOT NULL CHECK(traded_lots >= 0),
      total_value_lakhs REAL NOT NULL CHECK(total_value_lakhs >= 0),
      PRIMARY KEY(symbol, trade_date)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS activity_by_date
      ON activity(trade_date, symbol);
    CREATE TABLE IF NOT EXISTS import_log (
      id INTEGER PRIMARY KEY,
      dataset TEXT NOT NULL CHECK(dataset IN ('settlements', 'activity')),
      source TEXT NOT NULL,
      rows_written INTEGER NOT NULL CHECK(rows_written >= 0),
      imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);

  const seedRequire = createRequire(import.meta.url);
  require("./data/real-seed.js");
  const seedSettlements = analytics.mergeRecords([], globalThis.TOLA_REAL_SEED);
  const activityDatabase = seedRequire("./data/activity-data.js");
  analytics.summarizeActivity(activityDatabase.records, 20);

  db.exec("BEGIN IMMEDIATE");
  try {
    const insertSettlement = db.prepare(`
      INSERT OR IGNORE INTO settlements
        (symbol, trade_date, expiry_date, open, high, low, close, volume_lots, open_interest_lots)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    seedSettlements.forEach((row) => insertSettlement.run(
      row.symbol, row.date, row.expiry, row.open, row.high, row.low, row.close, row.volume, row.openInterest
    ));
    const insertActivity = db.prepare(`
      INSERT OR IGNORE INTO activity (symbol, trade_date, traded_lots, total_value_lakhs)
      VALUES (?, ?, ?, ?)
    `);
    activityDatabase.records.forEach((row) => insertActivity.run(
      row.symbol, row.date, row.tradedLots, row.totalValueLakhs
    ));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  return db;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "Request body exceeds the 12 MB limit");
    chunks.push(chunk);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return payload;
}

function authorizeAdmin(request, expectedToken) {
  if (!expectedToken) throw new HttpError(503, "Data imports are disabled until TOLA_ADMIN_TOKEN is configured");
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || "");
  const supplied = match ? match[1] : "";
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expectedToken);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(
    actualBytes.length === expectedBytes.length ? actualBytes : expectedBytes,
    expectedBytes
  )) {
    throw new HttpError(401, "A valid administrator bearer token is required");
  }
}

function rowsFrom(db, table, sql) {
  return db.prepare(sql).all().map((row) => {
    if (table === "settlements") {
      return {
        symbol: row.symbol,
        date: row.trade_date,
        expiry: row.expiry_date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume_lots,
        openInterest: row.open_interest_lots,
        synthetic: false
      };
    }
    return {
      symbol: row.symbol,
      date: row.trade_date,
      tradedLots: row.traded_lots,
      totalValueLakhs: row.total_value_lakhs
    };
  });
}

function upsertSettlements(db, records, source) {
  const validated = analytics.mergeRecords([], records);
  const insert = db.prepare(`
    INSERT INTO settlements
      (symbol, trade_date, expiry_date, open, high, low, close, volume_lots, open_interest_lots)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, trade_date, expiry_date) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
      volume_lots=excluded.volume_lots, open_interest_lots=excluded.open_interest_lots
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    validated.forEach((row) => insert.run(
      row.symbol, row.date, row.expiry, row.open, row.high, row.low, row.close, row.volume, row.openInterest
    ));
    db.prepare("INSERT INTO import_log (dataset, source, rows_written) VALUES ('settlements', ?, ?)")
      .run(source.slice(0, 250), validated.length);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return validated.length;
}

function upsertActivity(db, records, source) {
  analytics.summarizeActivity(records, 20);
  const keys = new Set();
  records.forEach((record) => {
    const key = `${record.date}|${record.symbol}`;
    if (keys.has(key)) throw new HttpError(400, `Duplicate ${record.symbol} activity on ${record.date}`);
    keys.add(key);
  });
  if (!records.length) throw new HttpError(400, "At least one activity record is required");
  const insert = db.prepare(`
    INSERT INTO activity (symbol, trade_date, traded_lots, total_value_lakhs)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(symbol, trade_date) DO UPDATE SET
      traded_lots=excluded.traded_lots, total_value_lakhs=excluded.total_value_lakhs
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    records.forEach((row) => insert.run(row.symbol, row.date, row.tradedLots, row.totalValueLakhs));
    db.prepare("INSERT INTO import_log (dataset, source, rows_written) VALUES ('activity', ?, ?)")
      .run(source.slice(0, 250), records.length);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return records.length;
}

export function createApplication({ databasePath = process.env.TOLA_DB_PATH || resolve(root, "data/tola.sqlite"), adminToken = process.env.TOLA_ADMIN_TOKEN || "" } = {}) {
  const db = openDatabase(databasePath);
  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");

    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/health") {
        const settlements = db.prepare("SELECT COUNT(*) AS count, MAX(trade_date) AS latest FROM settlements").get();
        const activity = db.prepare("SELECT COUNT(*) AS count, MAX(trade_date) AS latest FROM activity").get();
        sendJson(response, 200, {
          status: "ok",
          database: "sqlite",
          settlements: { records: settlements.count, through: settlements.latest },
          activity: { records: activity.count, through: activity.latest }
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/settlements") {
        sendJson(response, 200, rowsFrom(db, "settlements", "SELECT * FROM settlements ORDER BY trade_date, symbol, expiry_date"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/activity") {
        sendJson(response, 200, rowsFrom(db, "activity", "SELECT * FROM activity ORDER BY trade_date, symbol"));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/admin/import/settlements") {
        authorizeAdmin(request, adminToken);
        const payload = await readJson(request);
        if (typeof payload.csv !== "string") throw new HttpError(400, "Expected a csv string");
        const source = typeof payload.source === "string" ? payload.source : "admin-api";
        let records;
        try {
          records = analytics.parseBhavcopy(payload.csv);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
        const imported = upsertSettlements(db, records, source);
        sendJson(response, 200, { status: "ok", imported, latest: db.prepare("SELECT MAX(trade_date) AS date FROM settlements").get().date });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/admin/import/activity") {
        authorizeAdmin(request, adminToken);
        const payload = await readJson(request);
        if (!Array.isArray(payload.records)) throw new HttpError(400, "Expected records array");
        const source = typeof payload.source === "string" ? payload.source : "admin-api";
        try {
          analytics.summarizeActivity(payload.records, 20);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
        const imported = upsertActivity(db, payload.records, source);
        sendJson(response, 200, { status: "ok", imported, latest: db.prepare("SELECT MAX(trade_date) AS date FROM activity").get().date });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new HttpError(405, "Method not allowed");
      }
      const asset = ASSETS.get(url.pathname);
      if (!asset) throw new HttpError(404, "Not found");
      const file = resolve(root, asset);
      if (!file.startsWith(`${root}${sep}`)) throw new HttpError(404, "Not found");
      if (!existsSync(file)) throw new HttpError(404, "Not found");
      const body = readFileSync(file);
      response.writeHead(200, {
        "content-type": MIME_TYPES[extname(file)] || "application/octet-stream",
        "cache-control": "no-cache",
        "content-length": body.length
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) {
        console.error("Unhandled TOLA request error", error);
        sendJson(response, status, { error: "Internal server error" });
      } else {
        sendJson(response, status, { error: error.message || "Request failed" });
      }
    }
  });
  return { server, database: db };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { server, database } = createApplication();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, "0.0.0.0", () => {
    const address = server.address();
    console.log(`TOLA web app ready at http://localhost:${address.port}`);
    console.log(`SQLite database: ${process.env.TOLA_DB_PATH || resolve(root, "data/tola.sqlite")}`);
  });
  const shutdown = () => server.close(() => {
    database.close();
    process.exit(0);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
