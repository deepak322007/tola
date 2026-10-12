import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApplication } from "../server.mjs";

const require = createRequire(import.meta.url);
const analytics = require("../analytics.js");
const adminToken = "test-only-tola-admin-token";

test("serves live SQLite data and gates transactional imports behind the admin token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tola-test-"));
  const databasePath = join(directory, "test.sqlite");
  const { server, database } = createApplication({ databasePath, adminToken });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    assert.equal(health.status, "ok");
    assert.equal(health.settlements.records, 24);
    assert.equal(health.activity.records, 796);
    assert.equal(health.activity.through, "2026-10-08");

    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /TOLA/);
    const denied = await fetch(`${origin}/api/admin/import/settlements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv: "Symbol,Date" })
    });
    assert.equal(denied.status, 401);

    const csv = [
      "Instrument Name,Symbol,Date,Expiry Date,Open,High,Low,Close,Volume(Lots),Open Interest(Lots)",
      "FUTCOM,GOLDM,09 Oct 2026,05NOV2026,148000,149000,147000,148500,20,900",
      "FUTCOM,GOLDTEN,09 Oct 2026,05NOV2026,148000,149000,147000,148600,15,500"
    ].join("\n");
    const imported = await fetch(`${origin}/api/admin/import/settlements`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ source: "test.csv", csv })
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).imported, 2);
    const settlementRows = await fetch(`${origin}/api/settlements`).then((response) => response.json());
    assert.ok(settlementRows.some((row) => row.symbol === "GOLDM" && row.date === "2026-10-09" && row.close === 148500));

    const updatedCsv = csv.replace("148500", "148501");
    const updated = await fetch(`${origin}/api/admin/import/settlements`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ source: "replacement.csv", csv: updatedCsv })
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).imported, 2);
    const updatedRows = await fetch(`${origin}/api/settlements`).then((response) => response.json());
    assert.equal(updatedRows.filter((row) => row.symbol === "GOLDM" && row.date === "2026-10-09").length, 1);
    assert.ok(updatedRows.some((row) => row.symbol === "GOLDM" && row.date === "2026-10-09" && row.close === 148501));

    const reportFixture = [
      "<table><tr><th>Instrument</th><th>Date</th><th>Segment</th><th>Commodity</th><th>Traded Contract (Lots)</th><th>Total Value (Lakhs)</th></tr>",
      "<tr><td>FUTCOM</td><td>09 Oct 2026</td><td>BULLION</td><td>GOLDM</td><td>50</td><td>700.25</td></tr></table>"
    ].join("");
    const activity = await fetch(`${origin}/api/admin/import/activity`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ source: "report.xls", records: analytics.parseActivityReport(reportFixture) })
    });
    assert.equal(activity.status, 200);
    assert.equal((await activity.json()).imported, 1);
    const activities = await fetch(`${origin}/api/activity`).then((response) => response.json());
    assert.ok(activities.some((row) => row.symbol === "GOLDM" && row.date === "2026-10-09" && row.tradedLots === 50));

    const invalidImport = await fetch(`${origin}/api/admin/import/activity`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ source: "bad", records: [{ symbol: "GOLDM", date: "2026-10-10", tradedLots: -1, totalValueLakhs: 0 }] })
    });
    assert.equal(invalidImport.status, 400);
    assert.equal((await fetch(`${origin}/api/activity`).then((response) => response.json())).length, 797);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
