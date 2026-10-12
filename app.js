(function () {
  "use strict";

  const analytics = window.TolaAnalytics;
  const elements = {
    clock: document.getElementById("live-clock"),
    asOf: document.getElementById("as-of"),
    message: document.getElementById("message"),
    reference: document.getElementById("reference-select"),
    lookback: document.getElementById("lookback-select"),
    threshold: document.getElementById("threshold-select"),
    maxGap: document.getElementById("gap-select"),
    exitBuffer: document.getElementById("buffer-select"),
    cost: document.getElementById("cost-input"),
    chartSelect: document.getElementById("chart-select"),
    chartContract: document.getElementById("chart-contract"),
    chart: document.getElementById("spread-chart"),
    chartEmpty: document.getElementById("chart-empty"),
    chartPeriod: document.getElementById("chart-period"),
    signalCount: document.getElementById("signal-count"),
    signalNote: document.getElementById("signal-note"),
    observationCount: document.getElementById("observation-count"),
    strategyReturn: document.getElementById("strategy-return"),
    strategyNote: document.getElementById("strategy-note"),
    goldReturn: document.getElementById("gold-return"),
    activityRows: document.getElementById("activity-rows"),
    activityEmpty: document.getElementById("activity-empty"),
    monitorRows: document.getElementById("monitor-rows"),
    tableEmpty: document.getElementById("table-empty"),
    backtestRows: document.getElementById("backtest-rows"),
    backtestEmpty: document.getElementById("backtest-empty")
  };

  const analysisDetails = document.querySelector(".analysis");
  let records = [];
  let activityRecords = [];
  let result = null;
  let dataReady = false;
  const numberFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  const priceFormat = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const decimalFormat = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const clockFormat = new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  function updateClock() {
    const now = new Date();
    elements.clock.dateTime = now.toISOString();
    elements.clock.textContent = clockFormat.format(now);
  }

  updateClock();
  window.setInterval(updateClock, 1000);

  function showMessage(text, kind) {
    elements.message.textContent = text;
    elements.message.className = `message${kind === "success" ? " success" : ""}`;
    elements.message.hidden = false;
  }

  function hideMessage() {
    elements.message.hidden = true;
    elements.message.textContent = "";
  }

  function signed(value, suffix) {
    if (!Number.isFinite(value)) return "—";
    return `${value > 0 ? "+" : ""}${decimalFormat.format(value)}${suffix || ""}`;
  }

  function expiryLabel(value) {
    const date = new Date(`${value}T00:00:00Z`);
    return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" }).toUpperCase();
  }

  function updateContractOptions() {
    const comparisons = [...new Set(records.map((row) => row.symbol))]
      .filter((symbol) => symbol !== elements.reference.value)
      .sort();
    const current = elements.chartSelect.value;
    elements.chartSelect.replaceChildren(new Option("All contracts", "ALL"));
    comparisons.forEach((symbol) => elements.chartSelect.add(new Option(symbol, symbol)));
    if (comparisons.includes(current)) elements.chartSelect.value = current;
    else elements.chartSelect.value = "ALL";
  }

  function getOptions() {
    const cost = Number(elements.cost.value);
    return {
      reference: elements.reference.value,
      lookback: Number(elements.lookback.value),
      threshold: Number(elements.threshold.value),
      maxGap: Number(elements.maxGap.value),
      exitBuffer: Number(elements.exitBuffer.value),
      costPerLegBps: cost
    };
  }

  function renderMetrics(analysis, options) {
    const active = [...analysis.latest.values()].filter((pair) => pair.signal !== 0);
    elements.signalCount.textContent = String(active.length).padStart(2, "0");
    elements.signalNote.textContent = active.length
      ? active.map((pair) => `${pair.symbol} ${pair.signal > 0 ? "cheap" : "rich"}`).join(" · ")
      : "nothing past the threshold";
    elements.observationCount.textContent = numberFormat.format(analysis.pairs.length);

    const summaries = [...analysis.backtest.values()];
    if (!summaries.length) {
      elements.strategyReturn.textContent = "—";
      elements.strategyNote.textContent = "Insufficient eligible matched history";
      elements.goldReturn.textContent = "—";
      return;
    }
    const strategyBps = summaries.reduce((sum, summary) => sum + summary.netBps, 0) / summaries.length;
    const goldBps = summaries.reduce((sum, summary) => sum + summary.goldBps, 0) / summaries.length;
    elements.strategyReturn.textContent = signed(strategyBps);
    elements.strategyReturn.classList.toggle("negative", strategyBps < 0);
    elements.strategyNote.textContent = `Mean across ${summaries.length} pair portfolio${summaries.length === 1 ? "" : "s"} · ${options.costPerLegBps} bps/leg`;
    elements.goldReturn.textContent = signed(goldBps);
    elements.goldReturn.classList.toggle("negative", goldBps < 0);
  }

  function renderMonitor(analysis) {
    const last = analysis.dates[analysis.dates.length - 1];
    const rows = analysis.pairs.filter((pair) => pair.date === last)
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.reference.expiry.localeCompare(b.reference.expiry));
    elements.monitorRows.replaceChildren();
    elements.tableEmpty.hidden = rows.length > 0;
    rows.forEach((pair) => {
      const tr = document.createElement("tr");
      const signal = pair.signal > 0 ? `${pair.symbol} looks cheap` : pair.signal < 0 ? `${pair.symbol} looks rich` : pair.zScore === null ? "warming up" : "no flag";
      const signalClass = pair.signal > 0 ? "long" : pair.signal < 0 ? "short" : "";
      const cells = [
        { text: pair.symbol, className: "contract-cell" },
        { text: `${expiryLabel(pair.reference.expiry)} / ${expiryLabel(pair.comparison.expiry)}`, className: "numeric" },
        { text: `${pair.expiryGap}d`, className: "numeric" },
        { text: `₹${priceFormat.format(pair.comparisonPrice)}`, className: "numeric" },
        { text: signed(pair.premiumBps, " bp"), className: "numeric" },
        { text: pair.zScore === null ? "—" : signed(pair.zScore, "σ"), className: "numeric" },
        { text: `${numberFormat.format(pair.reference.volume)} / ${numberFormat.format(pair.comparison.volume)}`, className: "numeric" }
      ];
      cells.forEach((cell) => {
        const td = document.createElement("td");
        td.textContent = cell.text;
        if (cell.className) td.className = cell.className;
        tr.append(td);
      });
      const status = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `signal-chip ${signalClass}`;
      badge.textContent = signal;
      status.append(badge);
      tr.append(status);
      elements.monitorRows.append(tr);
    });
  }

  function renderActivity() {
    const rows = analytics.summarizeActivity(activityRecords, 20);
    elements.activityRows.replaceChildren();
    elements.activityEmpty.hidden = rows.length > 0;
    rows.forEach((summary) => {
      const row = document.createElement("tr");
      const change = summary.changeFromPriorAveragePct;
      const cells = [
        { text: summary.symbol, className: "contract-cell" },
        { text: expiryLabel(summary.date), className: "numeric" },
        { text: numberFormat.format(summary.tradedLots), className: "numeric" },
        {
          text: summary.priorAverageLots === null ? "—" : numberFormat.format(Math.round(summary.priorAverageLots)),
          className: "numeric"
        },
        {
          text: change === null ? "—" : signed(change, "%"),
          className: `numeric${change === null ? "" : change >= 0 ? " activity-positive" : " activity-negative"}`
        },
        { text: decimalFormat.format(summary.totalValueLakhs), className: "numeric" }
      ];
      cells.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value.text;
        cell.className = value.className;
        row.append(cell);
      });
      elements.activityRows.append(row);
    });
  }

  function renderBacktest(analysis) {
    const summaries = [...analysis.backtest.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
    elements.backtestRows.replaceChildren();
    elements.backtestEmpty.hidden = summaries.length > 0;
    summaries.forEach((summary) => {
      const row = document.createElement("tr");
      const values = [
        { text: `${elements.reference.value} / ${summary.symbol}`, className: "contract-cell" },
        { text: numberFormat.format(summary.observations), className: "numeric" },
        { text: numberFormat.format(summary.entries), className: "numeric" },
        { text: signed(summary.grossBps), className: "numeric" },
        { text: signed(-summary.costBps), className: "numeric" },
        { text: signed(summary.netBps), className: "numeric" },
        { text: signed(summary.goldBps), className: "numeric" },
        { text: decimalFormat.format(summary.sharpe), className: "numeric" }
      ];
      values.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value.text;
        cell.className = value.className;
        row.append(cell);
      });
      elements.backtestRows.append(row);
    });
  }

  function renderChart(analysis, threshold) {
    const selected = elements.chartSelect.value;
    const data = selected === "ALL"
      ? [...analysis.chartSeries.values()].flat()
      : (analysis.chartSeries.get(selected) || []);
    const chartData = selected === "ALL"
      ? aggregateChartDays(data)
      : data;
    elements.chartContract.textContent = selected === "ALL" ? "all contracts" : selected;
    elements.chartEmpty.hidden = chartData.length > 0;
    const canvas = elements.chart;
    const context = canvas.getContext("2d");
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    context.scale(ratio, ratio);
    context.clearRect(0, 0, bounds.width, bounds.height);

    if (chartData.length < 2) {
      elements.chartPeriod.textContent = "—";
      return;
    }
    const left = 41;
    const right = bounds.width - 12;
    const top = 15;
    const bottom = bounds.height - 26;
    const range = Math.max(threshold + 0.5, ...chartData.map((point) => Math.abs(point.zScore)).filter(Number.isFinite));
    const limit = Math.ceil(range);
    const y = (value) => top + (limit - value) / (2 * limit) * (bottom - top);
    const x = (index) => left + index / (chartData.length - 1) * (right - left);
    context.font = '11px ui-monospace, Consolas, monospace';
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let value = -limit; value <= limit; value += Math.max(1, Math.ceil(limit / 3))) {
      const coordinate = y(value);
      context.strokeStyle = value === 0 ? "#bdb59f" : "#e6dfcd";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(left, coordinate);
      context.lineTo(right, coordinate);
      context.stroke();
      context.fillStyle = "#6b665b";
      context.fillText(String(value), left - 8, coordinate);
    }
    [threshold, -threshold].forEach((value) => {
      context.strokeStyle = "#8a6a1f";
      context.setLineDash([4, 4]);
      context.beginPath();
      context.moveTo(left, y(value));
      context.lineTo(right, y(value));
      context.stroke();
      context.setLineDash([]);
    });
    const finitePoints = chartData.filter((point) => Number.isFinite(point.zScore));
    context.strokeStyle = "#2c5e45";
    context.lineWidth = 1.8;
    context.beginPath();
    finitePoints.forEach((point, index) => {
      const originalIndex = chartData.indexOf(point);
      if (index === 0) context.moveTo(x(originalIndex), y(point.zScore));
      else context.lineTo(x(originalIndex), y(point.zScore));
    });
    context.stroke();
    context.fillStyle = "#6b665b";
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText(shortDate(chartData[0].date), left, bottom + 8);
    context.textAlign = "right";
    context.fillText(shortDate(chartData[chartData.length - 1].date), right, bottom + 8);
    elements.chartPeriod.textContent = `${chartData.length} daily points · ${shortDate(chartData[0].date)} — ${shortDate(chartData[chartData.length - 1].date)}`;
  }

  function aggregateChartDays(points) {
    const grouped = new Map();
    points.forEach((point) => {
      if (!Number.isFinite(point.zScore)) return;
      if (!grouped.has(point.date)) grouped.set(point.date, []);
      grouped.get(point.date).push(point.zScore);
    });
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, values]) => ({ date, zScore: values.reduce((sum, value) => sum + value, 0) / values.length }));
  }

  function shortDate(date) {
    return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });
  }

  function render() {
    if (!dataReady) return;
    updateContractOptions();
    const options = getOptions();
    result = analytics.analyze(records, options);
    const latestDate = records.reduce((latest, row) => row.date > latest ? row.date : latest, "");
    const latestActivityDate = activityRecords.reduce((latest, row) => row.date > latest ? row.date : latest, "");
    elements.asOf.textContent = `price through ${latestDate || "no data"} · activity through ${latestActivityDate || "no data"}`;
    renderMetrics(result, options);
    renderActivity();
    renderMonitor(result);
    renderBacktest(result);
    renderChart(result, options.threshold);
  }

  [elements.reference, elements.lookback, elements.threshold, elements.maxGap, elements.exitBuffer, elements.cost, elements.chartSelect]
    .forEach((element) => element.addEventListener("change", () => {
      if (!dataReady) return;
      const cost = Number(elements.cost.value);
      if (!Number.isFinite(cost) || cost < 0 || cost > 100) {
        showMessage("One-way cost must be between 0 and 100 basis points per leg.", "error");
        return;
      }
      hideMessage();
      render();
    }));
  analysisDetails.addEventListener("toggle", () => {
    if (analysisDetails.open && result) renderChart(result, getOptions().threshold);
  });
  window.addEventListener("resize", () => { if (result) renderChart(result, getOptions().threshold); });

  async function loadDatabase() {
    try {
      const [healthResponse, settlementsResponse, activityResponse] = await Promise.all([
        fetch("/api/health", { cache: "no-store" }),
        fetch("/api/settlements", { cache: "no-store" }),
        fetch("/api/activity", { cache: "no-store" })
      ]);
      for (const response of [healthResponse, settlementsResponse, activityResponse]) {
        if (!response.ok) throw new Error(`TOLA API returned HTTP ${response.status}`);
      }
      const [health, settlementData, activityData] = await Promise.all([
        healthResponse.json(),
        settlementsResponse.json(),
        activityResponse.json()
      ]);
      if (!Array.isArray(settlementData) || !Array.isArray(activityData)
        || settlementData.length !== health.settlements.records
        || activityData.length !== health.activity.records) {
        throw new Error("TOLA API returned incomplete or invalid database contents");
      }
      records = analytics.mergeRecords([], settlementData);
      activityRecords = activityData;
      analytics.summarizeActivity(activityRecords, 20);
      dataReady = true;
      const latestPrice = health.settlements.through || "no settlement data";
      const latestActivity = health.activity.through || "no activity data";
      elements.asOf.textContent = `price through ${latestPrice} · activity through ${latestActivity}`;
      hideMessage();
      render();
    } catch (error) {
      elements.asOf.textContent = "Coverage dates are unavailable until the server connects.";
      hideMessage();
      console.error("TOLA could not load data from the app server", error);
    }
  }

  loadDatabase();
})();
