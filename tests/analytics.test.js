"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  analyze,
  CONTRACTS,
  mergeRecords,
  normalizePrice,
  parseBhavcopy,
  rollingZScores,
  summarizeActivity
} = require("../analytics.js");
require("../data/real-seed.js");
const activityDatabase = require("../data/activity-data.js");

test("normalizes differing quotation bases and purities to pure ₹ per 10g", () => {
  assert.equal(normalizePrice({ symbol: "GOLDM", close: 99.5 }), 100);
  assert.ok(Math.abs(normalizePrice({ symbol: "GOLDGUINEA", close: 79.92 }) - 100) < 1e-10);
  assert.deepEqual(CONTRACTS.GOLDM, { tradingUnit: 100, quoteBase: 10, purity: 995 });
});

test("parses padded symbols, MCX dates and compact expiry dates", () => {
  const csv = [
    "Symbol,Date,ExpiryDate,Open,High,Low,Close,Volume,OpenInterest",
    " GOLDM  ,09/04/2026,30SEP2026,99,101,98,99.5,1,2",
    "GOLDGUINEA,09/04/2026,30SEP2026,79,81,78,79.92,3,4"
  ].join("\r\n");
  const rows = parseBhavcopy(csv);
  assert.equal(rows.length, 2);
  const goldm = rows.find((row) => row.symbol === "GOLDM");
  assert.equal(goldm.date, "2026-09-04");
  assert.equal(goldm.expiry, "2026-09-30");
  assert.equal(goldm.synthetic, false);
});

test("loads the explicitly synthetic CSV smoke-test fixture", () => {
  const fixture = readFileSync(join(__dirname, "fixtures", "synthetic-bhavcopy.csv"), "utf8");
  const rows = parseBhavcopy(fixture);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.synthetic === false));
  const analysis = analyze(rows, {
    reference: "GOLDM",
    lookback: 20,
    threshold: 2,
    maxGap: 10,
    exitBuffer: 5,
    costPerLegBps: 5
  });
  assert.equal(analysis.backtest.size, 0);
});

test("parses native MCX daily bhavcopy, keeps futures only and reads lots", () => {
  const fixture = readFileSync(join(__dirname, "fixtures", "synthetic-mcx-native.csv"), "utf8");
  const rows = parseBhavcopy(fixture);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.date === "2026-10-07"));
  assert.ok(rows.every((row) => row.synthetic === false));
  const goldm = rows.find((row) => row.symbol === "GOLDM");
  assert.equal(goldm.expiry, "2026-11-05");
  assert.equal(goldm.volume, 41235);
  assert.equal(goldm.openInterest, 44589);
  assert.ok(Math.abs(normalizePrice(goldm) - 148640.20100502513) < 1e-8);
  const analysis = analyze(rows, {
    reference: "GOLDM",
    lookback: 20,
    threshold: 2,
    maxGap: 10,
    exitBuffer: 5,
    costPerLegBps: 5
  });
  assert.equal(analysis.pairs.length, 3);
  assert.equal(analysis.backtest.size, 0);
});

test("rejects duplicate contracts and malformed OHLC instead of silently dropping them", () => {
  const header = "Symbol,Date,ExpiryDate,Open,High,Low,Close,Volume,OpenInterest";
  const row = "GOLDM,09/04/2026,30SEP2026,100,99,98,99,1,2";
  assert.throws(() => parseBhavcopy(`${header}\n${row}`), /OHLC values are inconsistent/);
  const valid = "GOLDM,09/04/2026,30SEP2026,99,101,98,99.5,1,2";
  assert.throws(() => parseBhavcopy(`${header}\n${valid}\n${valid}`), /Duplicate symbol/);
  assert.throws(() => parseBhavcopy(`${header}\nGOLDM,09/31/2026,30SEP2026,99,101,98,99.5,1,2`), /Invalid calendar date/);
});

test("computes a z-score from prior observations, excluding the current value", () => {
  const rows = [1, 2, 3].map((premiumBps) => ({ premiumBps }));
  const analyzed = rollingZScores(rows, 2);
  assert.equal(analyzed[0].zScore, null);
  assert.equal(analyzed[1].zScore, null);
  assert.ok(Math.abs(analyzed[2].zScore - Math.sqrt(4.5)) < 1e-12);
});

test("bundled default is real one-session MCX data and makes no fabricated backtest", () => {
  const records = globalThis.TOLA_REAL_SEED;
  assert.equal(records.length, 24);
  assert.ok(records.every((row) => row.synthetic === false));
  assert.ok(records.every((row) => row.date === "2026-10-07"));
  const analysis = analyze(records, {
    reference: "GOLDM",
    lookback: 20,
    threshold: 2,
    maxGap: 10,
    exitBuffer: 5,
    costPerLegBps: 5
  });
  assert.equal(analysis.pairs.length, 18);
  assert.equal(analysis.backtest.size, 0);
  assert.ok(analysis.latest.has("GOLDTEN"));
  for (const pair of analysis.pairs) {
    assert.ok(pair.expiryGap <= 10);
    assert.ok(pair.reference.symbol === "GOLDM");
    assert.ok(pair.comparison.symbol === pair.symbol);
  }
});

test("loads 199 real MCX aggregate activity sessions without treating them as prices", () => {
  assert.equal(activityDatabase.coverage.from, "2026-01-01");
  assert.equal(activityDatabase.coverage.through, "2026-10-08");
  assert.equal(activityDatabase.coverage.sessions, 199);
  assert.equal(activityDatabase.records.length, 796);
  const summary = summarizeActivity(activityDatabase.records, 20);
  const goldm = summary.find((row) => row.symbol === "GOLDM");
  assert.equal(goldm.date, "2026-10-08");
  assert.equal(goldm.tradedLots, 48065);
  assert.equal(goldm.totalValueLakhs, 713983.22);
  assert.equal(goldm.priorSessionCount, 20);
  assert.ok(goldm.priorAverageLots > 0);
  assert.ok(Number.isFinite(goldm.changeFromPriorAveragePct));
  assert.equal(summary.length, 4);
});

test("parses real-world HTML-in-XLS MCX detail reports without mistaking options for futures", () => {
  const report = [
    "<table><thead><tr><th>Instrument</th><th>Date</th><th>Segment</th><th>Commodity</th><th>Traded Contract (Lots)</th><th>Total Value (Lakhs)</th><th>Avg Daily Turnover(Lakhs)</th><th>Premium Value (Lakhs)</th></tr></thead><tbody>",
    "<tr><td>FUTCOM</td><td>08 Oct 2026</td><td>BULLION</td><td>GOLDM</td><td>48,065</td><td>713,983.22</td><td>0.00</td><td>713,983.22</td></tr>",
    "<tr><td>OPTFUT</td><td>08 Oct 2026</td><td>BULLION</td><td>GOLDM</td><td>99</td><td>1.00</td><td>0.00</td><td>1.00</td></tr>",
    "<tr><td>FUTCOM</td><td>08 Oct 2026</td><td>BULLION</td><td>GOLDTEN</td><td>33,552</td><td>50,113.76</td><td>0.00</td><td>50,113.76</td></tr>",
    "</tbody></table>"
  ].join("");
  const records = require("../analytics.js").parseActivityReport(report);
  assert.equal(records.length, 2);
  assert.equal(records[0].symbol, "GOLDM");
  assert.equal(records[0].tradedLots, 48065);
  assert.equal(records[0].totalValueLakhs, 713983.22);
  assert.equal(records[0].date, "2026-10-08");
});

test("merges sessions, replaces re-imported contracts, and rejects invalid stored data", () => {
  const seeded = mergeRecords([], globalThis.TOLA_REAL_SEED);
  const changedClose = { ...seeded[0], close: seeded[0].close + 1 };
  const merged = mergeRecords(seeded, [changedClose]);
  assert.equal(merged.length, seeded.length);
  assert.equal(merged.find((row) => row.symbol === changedClose.symbol && row.expiry === changedClose.expiry && row.date === changedClose.date).close, changedClose.close);
  assert.throws(() => mergeRecords([], [{ ...seeded[0], close: NaN }]), /invalid close/);
  const nextSession = { ...seeded[0], date: "2026-10-08" };
  assert.equal(mergeRecords(seeded, [nextSession]).length, seeded.length + 1);
});

test("walk-forward backtest lags execution, charges both legs, and separates the reference move", () => {
  const records = [];
  const expiry = "2026-06-30";
  let day = new Date("2026-05-01T00:00:00Z");
  let index = 0;
  while (day < new Date(`${expiry}T00:00:00Z`)) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      const date = day.toISOString().slice(0, 10);
      const comparisonClose = 1000 * (index >= 10 && index <= 12 ? 1.02 : 1);
      records.push(
        { symbol: "GOLDM", date, expiry, open: 1000, high: 1010, low: 990, close: 1000, volume: 100, openInterest: 500 },
        { symbol: "GOLDTEN", date, expiry, open: comparisonClose, high: comparisonClose * 1.01, low: comparisonClose * 0.99, close: comparisonClose, volume: 80, openInterest: 300 }
      );
      index += 1;
    }
    day = new Date(day.getTime() + 86400000);
  }
  const analysis = analyze(records, {
    reference: "GOLDM",
    lookback: 10,
    threshold: 2,
    maxGap: 0,
    exitBuffer: 2,
    costPerLegBps: 5
  });
  const summary = analysis.backtest.get("GOLDTEN");
  assert.ok(summary.entries > 0);
  assert.ok(summary.costBps >= 20);
  assert.ok(summary.grossBps > summary.costBps);
  assert.ok(Math.abs(summary.netBps - (summary.grossBps - summary.costBps)) < 1e-8);
  assert.equal(summary.goldBps, 0);
});
