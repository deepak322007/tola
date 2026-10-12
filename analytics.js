(function (root) {
  "use strict";

  const CONTRACTS = {
    GOLDM: { tradingUnit: 100, quoteBase: 10, purity: 995 },
    GOLDTEN: { tradingUnit: 10, quoteBase: 10, purity: 999 },
    GOLDGUINEA: { tradingUnit: 8, quoteBase: 8, purity: 999 },
    GOLDPETAL: { tradingUnit: 1, quoteBase: 1, purity: 999 }
  };
  const DAY_MS = 86400000;

  function utcDate(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
      throw new Error("Invalid calendar date");
    }
    return date;
  }

  function dateKey(date) {
    return date.toISOString().slice(0, 10);
  }

  function parseDate(value, compactExpiry) {
    const text = String(value || "").trim();
    let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (match) return dateKey(utcDate(Number(match[1]), Number(match[2]), Number(match[3])));

    match = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(text);
    if (match) {
      const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].indexOf(match[2].toUpperCase()) + 1;
      if (month) return dateKey(utcDate(Number(match[3]), month, Number(match[1])));
    }

    if (compactExpiry) {
      match = /^(\d{1,2})([A-Za-z]{3})(\d{4})$/.exec(text);
      if (match) {
        const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
        const month = months.indexOf(match[2].toUpperCase()) + 1;
        if (month) return dateKey(utcDate(Number(match[3]), month, Number(match[1])));
      }
    }

    match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (match) {
      let month = Number(match[1]);
      let day = Number(match[2]);
      if (month > 12 && day <= 12) {
        month = Number(match[2]);
        day = Number(match[1]);
      }
      const parsed = utcDate(Number(match[3]), month, day);
      if (parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day) return dateKey(parsed);
    }
    throw new Error(`Unrecognized ${compactExpiry ? "expiry" : "date"} "${text}"`);
  }

  function daysBetween(left, right) {
    return Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / DAY_MS);
  }

  function parseNumber(value, label, allowZero) {
    const text = String(value ?? "").trim().replace(/,/g, "");
    if (!text) throw new Error(`${label} is blank`);
    const number = Number(text);
    if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
      throw new Error(`${label} must be ${allowZero ? "non-negative" : "greater than zero"}`);
    }
    return number;
  }

  function readCsvRows(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    const source = text.replace(/^\uFEFF/, "");
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quoted && char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        row.push(cell);
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && source[index + 1] === "\n") index += 1;
        row.push(cell);
        if (row.some((part) => part.trim() !== "")) rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }
    if (quoted) throw new Error("CSV contains an unclosed quoted field");
    row.push(cell);
    if (row.some((part) => part.trim() !== "")) rows.push(row);
    return rows;
  }

  function parseBhavcopy(text) {
    const rows = readCsvRows(text);
    if (rows.length < 2) throw new Error("CSV must include a header and at least one data row");

    const headers = rows[0].map((name) => name.trim().toLowerCase().replace(/[^a-z]/g, ""));
    const nativeMcx = headers.includes("instrumentname") && headers.includes("volumelots") && headers.includes("openinterestlots");
    const required = ["symbol", "date", "expirydate", "open", "high", "low", "close",
      nativeMcx ? "volumelots" : "volume",
      nativeMcx ? "openinterestlots" : "openinterest"];
    const missing = required.filter((name) => !headers.includes(name));
    if (missing.length) throw new Error(`Missing required bhavcopy column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
    const columns = Object.fromEntries(required.map((name) => [name, headers.indexOf(name)]));
    const records = [];
    const errors = [];
    const seen = new Set();

    rows.slice(1).forEach((cells, index) => {
      const line = index + 2;
      const symbol = String(cells[columns.symbol] || "").trim().toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(CONTRACTS, symbol)) return;
      if (nativeMcx && String(cells[headers.indexOf("instrumentname")] || "").trim().toUpperCase() !== "FUTCOM") return;
      try {
        const record = {
          symbol,
          date: parseDate(cells[columns.date], false),
          expiry: parseDate(cells[columns.expirydate], true),
          open: parseNumber(cells[columns.open], "Open", false),
          high: parseNumber(cells[columns.high], "High", false),
          low: parseNumber(cells[columns.low], "Low", false),
          close: parseNumber(cells[columns.close], "Close", false),
          volume: parseNumber(cells[columns[nativeMcx ? "volumelots" : "volume"]], "Volume (lots)", true),
          openInterest: parseNumber(cells[columns[nativeMcx ? "openinterestlots" : "openinterest"]], "OpenInterest (lots)", true)
        };
        if (record.low > Math.min(record.open, record.close) || record.high < Math.max(record.open, record.close) || record.low > record.high) {
          throw new Error("OHLC values are inconsistent");
        }
        const key = `${record.symbol}|${record.date}|${record.expiry}`;
        if (seen.has(key)) throw new Error("Duplicate symbol / date / expiry row");
        seen.add(key);
        record.line = line;
        record.synthetic = false;
        records.push(record);
      } catch (error) {
        errors.push(`Line ${line}: ${error.message}`);
      }
    });

    if (errors.length) {
      const summary = errors.slice(0, 4).join("; ");
      throw new Error(`${errors.length} invalid supported-contract row${errors.length === 1 ? "" : "s"}. ${summary}${errors.length > 4 ? "; …" : ""}`);
    }
    if (!records.length) throw new Error("No GOLDM, GOLDTEN, GOLDGUINEA or GOLDPETAL rows were found in this CSV");
    return records.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol) || a.expiry.localeCompare(b.expiry));
  }

  function normalizePrice(record) {
    const contract = CONTRACTS[record.symbol];
    return record.close * (10 / contract.quoteBase) / (contract.purity / 1000);
  }

  function mergeRecords(existingRecords, incomingRecords) {
    const merged = new Map();
    [...existingRecords, ...incomingRecords].forEach((record) => {
      if (!record || !Object.prototype.hasOwnProperty.call(CONTRACTS, record.symbol)) {
        throw new Error("Saved data contains an unsupported contract");
      }
      const date = parseDate(record.date, false);
      const expiry = parseDate(record.expiry, true);
      ["open", "high", "low", "close", "volume", "openInterest"].forEach((field) => {
        if (!Number.isFinite(record[field]) || (field === "volume" || field === "openInterest" ? record[field] < 0 : record[field] <= 0)) {
          throw new Error(`Saved ${record.symbol} row has invalid ${field}`);
        }
      });
      if (record.low > Math.min(record.open, record.close) || record.high < Math.max(record.open, record.close) || record.low > record.high) {
        throw new Error(`Saved ${record.symbol} row has inconsistent OHLC values`);
      }
      const normalized = {
        symbol: record.symbol,
        date,
        expiry,
        open: record.open,
        high: record.high,
        low: record.low,
        close: record.close,
        volume: record.volume,
        openInterest: record.openInterest,
        synthetic: false
      };
      merged.set(`${normalized.symbol}|${normalized.date}|${normalized.expiry}`, normalized);
    });
    return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)
      || a.symbol.localeCompare(b.symbol) || a.expiry.localeCompare(b.expiry));
  }

  function rollingZScores(rows, lookback) {
    const history = [];
    return rows.map((row) => {
      if (history.length < lookback) {
        history.push(row.premiumBps);
        return { ...row, zScore: null, signal: 0 };
      }
      const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
      const variance = history.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (history.length - 1);
      const standardDeviation = Math.sqrt(variance);
      const zScore = standardDeviation > 1e-9 ? (row.premiumBps - mean) / standardDeviation : null;
      history.push(row.premiumBps);
      if (history.length > lookback) history.shift();
      return { ...row, zScore, signal: 0 };
    });
  }

  function summarizeActivity(records, lookback) {
    if (!Number.isInteger(lookback) || lookback < 1) throw new Error("Activity lookback must be a positive whole number");
    const groups = new Map();
    records.forEach((record) => {
      if (!Object.prototype.hasOwnProperty.call(CONTRACTS, record.symbol)) {
        throw new Error(`Unsupported activity contract "${record.symbol}"`);
      }
      const date = parseDate(record.date, false);
      if (!Number.isFinite(record.tradedLots) || record.tradedLots < 0
        || !Number.isFinite(record.totalValueLakhs) || record.totalValueLakhs < 0) {
        throw new Error(`Invalid activity record for ${record.symbol} on ${date}`);
      }
      if (!groups.has(record.symbol)) groups.set(record.symbol, []);
      groups.get(record.symbol).push({ ...record, date });
    });
    return [...groups.entries()].map(([symbol, rows]) => {
      rows.sort((left, right) => left.date.localeCompare(right.date));
      const latest = rows[rows.length - 1];
      const prior = rows.slice(Math.max(0, rows.length - lookback - 1), -1);
      const averageLots = prior.length
        ? prior.reduce((sum, row) => sum + row.tradedLots, 0) / prior.length
        : null;
      return {
        symbol,
        date: latest.date,
        tradedLots: latest.tradedLots,
        totalValueLakhs: latest.totalValueLakhs,
        priorSessionCount: prior.length,
        priorAverageLots: averageLots,
        changeFromPriorAveragePct: averageLots > 0 ? (latest.tradedLots / averageLots - 1) * 100 : null
      };
    }).sort((left, right) => left.symbol.localeCompare(right.symbol));
  }

  function parseActivityReport(source) {
    if (typeof source !== "string" || !/<table\b/i.test(source)) {
      throw new Error("Activity report must be the MCX HTML-in-XLS DateWise detail report");
    }
    function cleanCell(value) {
      return value.replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    }
    const rows = [...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((row) => [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)]
        .map((cell) => cleanCell(cell[1])));
    if (rows.length < 2) throw new Error("Activity report has no data rows");
    const headers = rows[0].map((header) => header.toLowerCase());
    const required = ["instrument", "date", "segment", "commodity", "traded contract (lots)", "total value (lakhs)"];
    const columns = Object.fromEntries(required.map((name) => [name, headers.indexOf(name)]));
    const missing = required.filter((name) => columns[name] < 0);
    if (missing.length) throw new Error(`Activity report is missing columns: ${missing.join(", ")}`);
    const supported = new Set(Object.keys(CONTRACTS));
    const records = [];
    const seen = new Set();
    rows.slice(1).forEach((cells, index) => {
      const instrument = cells[columns.instrument];
      const segment = cells[columns.segment];
      const symbol = cells[columns.commodity];
      if (instrument !== "FUTCOM" || segment !== "BULLION" || !supported.has(symbol)) return;
      const record = {
        date: parseDate(cells[columns.date], false),
        symbol,
        tradedLots: parseNumber(cells[columns["traded contract (lots)"]], `Line ${index + 2} traded lots`, true),
        totalValueLakhs: parseNumber(cells[columns["total value (lakhs)"]], `Line ${index + 2} total value`, true)
      };
      const key = `${record.date}|${record.symbol}`;
      if (seen.has(key)) throw new Error(`Duplicate ${record.symbol} activity on ${record.date}`);
      seen.add(key);
      records.push(record);
    });
    if (!records.length) throw new Error("Activity report contains no supported gold FUTCOM rows");
    return records.sort((left, right) => left.date.localeCompare(right.date) || left.symbol.localeCompare(right.symbol));
  }

  function pairContracts(records, reference, maxGap, exitBuffer) {
    const byDate = new Map();
    records.forEach((record) => {
      if (!byDate.has(record.date)) byDate.set(record.date, new Map());
      const symbols = byDate.get(record.date);
      if (!symbols.has(record.symbol)) symbols.set(record.symbol, []);
      symbols.get(record.symbol).push(record);
    });
    const pairs = [];
    byDate.forEach((symbols, date) => {
      const referenceRows = symbols.get(reference) || [];
      for (const [symbol, comparisonRows] of symbols) {
        if (symbol === reference) continue;
        const candidates = [];
        referenceRows.forEach((referenceRow) => comparisonRows.forEach((comparisonRow) => {
          const expiryGap = Math.abs(daysBetween(referenceRow.expiry, comparisonRow.expiry));
          const lastSafeDate = daysBetween(date, referenceRow.expiry) <= daysBetween(date, comparisonRow.expiry)
            ? referenceRow.expiry : comparisonRow.expiry;
          if (expiryGap <= maxGap && daysBetween(date, lastSafeDate) > exitBuffer) {
            candidates.push({ referenceRow, comparisonRow, expiryGap });
          }
        }));
        candidates.sort((a, b) => a.expiryGap - b.expiryGap
          || a.referenceRow.expiry.localeCompare(b.referenceRow.expiry)
          || a.comparisonRow.expiry.localeCompare(b.comparisonRow.expiry));
        const usedReference = new Set();
        const usedComparison = new Set();
        candidates.forEach((candidate) => {
          if (usedReference.has(candidate.referenceRow.expiry) || usedComparison.has(candidate.comparisonRow.expiry)) return;
          usedReference.add(candidate.referenceRow.expiry);
          usedComparison.add(candidate.comparisonRow.expiry);
          const referencePrice = normalizePrice(candidate.referenceRow);
          const comparisonPrice = normalizePrice(candidate.comparisonRow);
          pairs.push({
            symbol,
            date,
            reference: candidate.referenceRow,
            comparison: candidate.comparisonRow,
            referencePrice,
            comparisonPrice,
            expiryGap: candidate.expiryGap,
            premiumBps: (comparisonPrice / referencePrice - 1) * 10000,
            zScore: null,
            signal: 0
          });
        });
      }
    });
    return pairs;
  }

  function getSignal(zScore, threshold) {
    if (zScore === null || !Number.isFinite(zScore)) return 0;
    if (zScore <= -threshold) return 1;
    if (zScore >= threshold) return -1;
    return 0;
  }

  function backtestPairGroups(pairs, threshold, costPerLegBps) {
    const groups = new Map();
    pairs.forEach((pair) => {
      const key = `${pair.symbol}|${pair.reference.expiry}|${pair.comparison.expiry}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pair);
    });
    const daily = new Map();
    const totals = new Map();
    groups.forEach((rows) => {
      rows.sort((a, b) => a.date.localeCompare(b.date));
      if (!totals.has(rows[0].symbol)) totals.set(rows[0].symbol, { entries: 0, expiries: new Set() });
      totals.get(rows[0].symbol).expiries.add(`${rows[0].reference.expiry}|${rows[0].comparison.expiry}`);
      let position = 0;
      for (let index = 1; index < rows.length - 1; index += 1) {
        const prior = rows[index - 1];
        const execution = rows[index];
        const next = rows[index + 1];
        const target = getSignal(prior.zScore, threshold);
        const cost = 2 * costPerLegBps * Math.abs(target - position) / 10000;
        if (target !== 0 && target !== position) totals.get(rows[0].symbol).entries += 1;
        position = target;
        const comparisonReturn = next.comparisonPrice / execution.comparisonPrice - 1;
        const referenceReturn = next.referencePrice / execution.referencePrice - 1;
        const gross = position * (comparisonReturn - referenceReturn);
        const item = daily.get(next.date) || new Map();
        const symbolValues = item.get(rows[0].symbol) || { gross: 0, cost: 0, reference: 0, count: 0 };
        symbolValues.gross += gross;
        symbolValues.cost += cost;
        symbolValues.reference += referenceReturn;
        symbolValues.count += 1;
        item.set(rows[0].symbol, symbolValues);
        daily.set(next.date, item);
      }
      if (position !== 0 && rows.length > 1) {
        const terminal = rows[rows.length - 1];
        const item = daily.get(terminal.date) || new Map();
        const symbolValues = item.get(rows[0].symbol) || { gross: 0, cost: 0, reference: 0, count: 0 };
        symbolValues.cost += 2 * costPerLegBps / 10000;
        symbolValues.count += 1;
        item.set(rows[0].symbol, symbolValues);
        daily.set(terminal.date, item);
      }
    });

    const results = new Map();
    [...totals.keys()].forEach((symbol) => {
      const observations = [];
      [...daily.keys()].sort().forEach((date) => {
        const item = daily.get(date).get(symbol);
        if (!item) return;
        observations.push({
          date,
          gross: item.gross / item.count,
          cost: item.cost / item.count,
          reference: item.reference / item.count
        });
      });
      const netReturns = observations.map((row) => row.gross - row.cost);
      const mean = netReturns.length ? netReturns.reduce((sum, value) => sum + value, 0) / netReturns.length : 0;
      const variance = netReturns.length > 1
        ? netReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (netReturns.length - 1)
        : 0;
      let cumulative = 0;
      let peak = 0;
      let maxDrawdown = 0;
      netReturns.forEach((value) => {
        cumulative += value;
        peak = Math.max(peak, cumulative);
        maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
      });
      const values = observations.reduce((result, row) => ({
        gross: result.gross + row.gross,
        cost: result.cost + row.cost,
        reference: result.reference + row.reference
      }), { gross: 0, cost: 0, reference: 0 });
      if (!observations.length) return;
      results.set(symbol, {
        symbol,
        observations: observations.length,
        entries: totals.get(symbol).entries,
        expiries: totals.get(symbol).expiries.size,
        grossBps: values.gross * 10000,
        costBps: values.cost * 10000,
        netBps: (values.gross - values.cost) * 10000,
        goldBps: values.reference * 10000,
        sharpe: variance > 0 ? mean / Math.sqrt(variance) * Math.sqrt(252) : 0,
        maxDrawdownBps: maxDrawdown * 10000
      });
    });
    return results;
  }

  function analyze(records, options) {
    const pairs = pairContracts(records, options.reference, options.maxGap, options.exitBuffer);
    const groups = new Map();
    pairs.forEach((pair) => {
      const key = `${pair.symbol}|${pair.reference.expiry}|${pair.comparison.expiry}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pair);
    });
    const analyzedPairs = [];
    groups.forEach((rows) => {
      const analyzed = rollingZScores(rows.sort((a, b) => a.date.localeCompare(b.date)), options.lookback)
        .map((row) => ({ ...row, signal: getSignal(row.zScore, options.threshold) }));
      analyzedPairs.push(...analyzed);
    });
    analyzedPairs.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));

    const latest = new Map();
    analyzedPairs.forEach((pair) => {
      const current = latest.get(pair.symbol);
      const pairFrontExpiry = pair.reference.expiry < pair.comparison.expiry ? pair.reference.expiry : pair.comparison.expiry;
      const currentFrontExpiry = current && current.reference.expiry < current.comparison.expiry ? current.reference.expiry : current && current.comparison.expiry;
      if (!current || pair.date > current.date
        || (pair.date === current.date && pairFrontExpiry < currentFrontExpiry)
        || (pair.date === current.date && pairFrontExpiry === currentFrontExpiry && pair.expiryGap < current.expiryGap)) {
        latest.set(pair.symbol, pair);
      }
    });
    const backtest = backtestPairGroups(analyzedPairs, options.threshold, options.costPerLegBps);
    const series = new Map();
    analyzedPairs.forEach((pair) => {
      if (pair.zScore === null) return;
      if (!series.has(pair.symbol)) series.set(pair.symbol, new Map());
      const symbolSeries = series.get(pair.symbol);
      if (!symbolSeries.has(pair.date)) symbolSeries.set(pair.date, []);
      symbolSeries.get(pair.date).push(pair.zScore);
    });
    const chartSeries = new Map();
    series.forEach((days, symbol) => {
      chartSeries.set(symbol, [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, values]) => ({ date, zScore: values.reduce((sum, value) => sum + value, 0) / values.length })));
    });
    return {
      pairs: analyzedPairs,
      latest,
      backtest,
      chartSeries,
      dates: [...new Set(analyzedPairs.map((pair) => pair.date))].sort()
    };
  }

  const api = {
    CONTRACTS,
    analyze,
    mergeRecords,
    normalizePrice,
    parseActivityReport,
    parseBhavcopy,
    parseDate,
    rollingZScores,
    summarizeActivity
  };
  root.TolaAnalytics = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
