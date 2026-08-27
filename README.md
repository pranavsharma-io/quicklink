# QuickLink Hyper - D1 Setup Guide

Note that the current worker code uses Cloudflare **KV** (`env.URL_STORE`), not D1. If you want to use D1 (SQL database) instead, follow the steps below — first you'll create the D1 database, then update the worker to use D1 queries.

## Step 1: Install Wrangler CLI

```bash
npm install -g wrangler
```

## Step 2: Login to Cloudflare

```bash
wrangler login
```

## Step 3: Create a D1 Database

```bash
wrangler d1 create quicklink-db
```

This command will return a `database_id` — save it, you'll need it in the next step.

## Step 4: Add D1 Binding in wrangler.toml

```toml
name = "quicklink-hyper"
main = "worker.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "quicklink-db"
database_id = "your-database-id-here"
```

## Step 5: Create the Table Schema

Create a file called `schema.sql`:

```sql
CREATE TABLE links (
  shortCode TEXT PRIMARY KEY,
  adminCode TEXT NOT NULL,
  longUrl TEXT NOT NULL,
  password TEXT,
  geo TEXT,
  expiresAt TEXT,
  maxClicks INTEGER,
  deviceUrls TEXT,
  customHtml TEXT,
  abTestUrl TEXT,
  utmParams TEXT,
  pixelId TEXT,
  visitCount INTEGER DEFAULT 0
);

CREATE TABLE visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shortCode TEXT NOT NULL,
  timestamp TEXT,
  ip TEXT,
  country TEXT
);
```

## Step 6: Apply Schema to D1

```bash
wrangler d1 execute quicklink-db --file=./schema.sql
```

## Step 7: Update Worker Code

Replace KV calls like `env.URL_STORE.get()` and `env.URL_STORE.put()` with D1 SQL queries, for example:

```js
const result = await env.DB.prepare(
  "SELECT * FROM links WHERE shortCode = ?"
).bind(shortCode).first();

await env.DB.prepare(
  "INSERT INTO links (shortCode, adminCode, longUrl) VALUES (?, ?, ?)"
).bind(shortCode, adminCode, longUrl).run();
```

> Every place where `env.URL_STORE.get/put` is used needs to be replaced with a D1 query like the one above. Let me know if you'd like the full worker code rewritten for D1.

## Step 8: Deploy

```bash
wrangler deploy
```

## Step 9: Test

Once deployed, open the worker URL and test by creating a short link.