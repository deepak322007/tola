# TOLA — MCX gold futures web app

TOLA is a same-origin web app backed by a persistent SQLite database and a Node.js HTTP API. The browser fetches current rows from the server; it does not ship the database inside the page, generate market observations, or persist per-user substitutes in local storage.

## Run locally

Requires Node.js 24 (minimum 22.13).

```powershell
npm.cmd start
```

Open **http://localhost:3000**. `index.html` opened directly as a `file://` URL is no longer the app: the API and database require the server.

## Use the dashboard

The main page shows the latest contract comparisons and trading activity. Open **Analysis settings** to adjust the reference contract, history window, signal threshold, expiry limits, or estimated trading cost. Open **More analysis** for the historical chart, calculation notes, and strategy test. A “cheap” or “rich” flag describes an unusual historical price gap; it is not a trade recommendation. If the database has too little settlement history, the app reports that there is not enough data instead of inventing a result.

The first start creates `data/tola.sqlite` and seeds it from:

- `data/real-seed.js`: 24 real settlement rows from the supplied 7 October 2026 MCX bhavcopy;
- `data/activity-data.js`: 796 real bullion futures activity rows for 199 sessions, 1 January–8 October 2026.

Set `TOLA_DB_PATH` to choose a different SQLite file. Existing rows are preserved on restart; imported rows upsert on contract/session/expiry, so corrections replace the matching record instead of duplicating it. Keep the SQLite file on persistent storage when deploying.

## Update production data

There is deliberately no public upload control. Start the server with a long, private `TOLA_ADMIN_TOKEN`, then use the CLI to validate and send one or more actual MCX daily futures bhavcopies and/or the MCX DateWise HTML-in-XLS activity report:

```powershell
$env:TOLA_ADMIN_TOKEN = "<the-private-token-configured-on-the-server>"
node scripts/import-mcx.mjs --url "https://your-tola-host.example" `
  --settlements "C:\path\to\BhavCopyDateWise_09102026.csv" `
  --activity "C:\path\to\DateWise Detail report.xls"
```

Repeat `--settlements` to submit multiple CSV sessions. The importer checks the actual session dates in the files, filters native daily files to supported `FUTCOM` gold futures, ignores option rows, and rejects malformed supported rows. Check the reported dates: an exchange response that silently returns a neighboring session cannot be identified by filename alone.

For local imports, start the server with `$env:TOLA_ADMIN_TOKEN = "your-private-token"` in its terminal before `npm start`; set the same token in the CLI terminal when running the import command.

The API also serves JSON:

- `GET /api/health`
- `GET /api/settlements`
- `GET /api/activity`
- `POST /api/admin/import/settlements` with `Authorization: Bearer <TOLA_ADMIN_TOKEN>` and JSON `{ "source": "filename.csv", "csv": "<CSV text>" }`
- `POST /api/admin/import/activity` with the same authentication and JSON `{ "source": "filename.xls", "records": [...] }`

Imports are validated before a transaction and the admin endpoints are disabled if `TOLA_ADMIN_TOKEN` is unset. Never publish the admin token or commit it to source control. The included importer CLI parses the supplied MCX HTML-in-XLS activity report locally; the web server does not expose an unauthenticated upload route.

## Public deployment

### Render Blueprint

1. Push this project folder to a GitHub repository you control.
2. In Render, create a **Blueprint** from that repository and select `render.yaml`.
3. The service provisions a persistent disk at `/var/data` for `tola.sqlite` and generates `TOLA_ADMIN_TOKEN`. Use a persistent-disk-capable plan; an ephemeral filesystem loses database updates on restart or redeploy.
4. Once the deployment is healthy, open its `https://…onrender.com` address. The app's same-origin API is served by the Node service.
5. To update the database, securely set `TOLA_ADMIN_TOKEN` in your terminal (copy the generated secret from Render's service environment), then run the importer command above with the Render URL.

### Docker

```powershell
docker build -t tola-mcx-gold .
docker run --name tola-mcx-gold -p 3000:3000 `
  -e TOLA_ADMIN_TOKEN="replace-with-a-long-random-secret" `
  -v tola-data:/var/lib/tola tola-mcx-gold
```

Use HTTPS and a durable volume for an internet-facing deployment. No deployment provider credentials are present in this project, so a public hostname must be provisioned through an account you control.

## Database and API

The API returns exchange settlements and aggregate activity as distinct datasets. The 796-row activity report aggregates across expiries; volume and turnover are useful context, **not** market depth, executable capacity, settlement prices, or strategy returns. That report extends activity coverage to 8 October but does not extend the settlement-price sample beyond the supplied 7 October bhavcopy.

Settlement comparisons normalize purity and quotation base, keep actual expiry pairs separate, and never substitute aggregate activity for missing close prices. A one-session price sample correctly produces no backtest. It takes multiple real settlement sessions per matched expiry to warm up a z-score and evaluate walk-forward performance.

SQLite should run as a single web-service instance on a persistent disk. If you later require multiple application instances, move the persistence layer to a managed database such as PostgreSQL instead of placing SQLite on a shared network filesystem.

## Tests

```powershell
npm.cmd test
npm.cmd run check
```

Tests exercise contract normalization, native MCX parsers, activity statistics, database persistence routes, administrator authentication, import validation, and same-session upserts.
