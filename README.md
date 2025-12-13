# Web Scraper Service 🕷️

A standalone web scraping service designed to be deployed separately from your main application. It scrapes website content and indexes it to Upstash Vector for RAG (Retrieval-Augmented Generation) applications.

## Why Separate?

- **No Timeout Limits**: GitHub Actions allows up to 6 hours of runtime
- **No Memory Constraints**: Not limited by serverless function memory
- **Parallel Processing**: Can handle many URLs concurrently
- **Private Product Code**: Keep your main app code private while this service can be public

## Quick Start

### Local Development

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Configure environment:**

   ```bash
   cp env.example.txt .env
   # Edit .env with your Upstash credentials
   ```

3. **Run the scraper:**

   ```bash
   # Scrape with Cheerio (fast, static sites)
   npm run scrape -- --urls="https://example.com,https://example.com/about" --brand=mysite

   # Scrape with Puppeteer (JavaScript-rendered sites)
   npm run scrape -- --urls="https://example.com" --brand=mysite --engine=puppeteer
   ```

### GitHub Actions (Production)

1. **Fork/clone this repository** to your own GitHub account

2. **Add repository secrets:**
   - `UPSTASH_VECTOR_REST_URL` - Your Upstash Vector REST URL
   - `UPSTASH_VECTOR_REST_TOKEN` - Your Upstash Vector REST Token
   - `UPSTASH_REDIS_REST_URL` (optional) - For job status tracking
   - `UPSTASH_REDIS_REST_TOKEN` (optional) - For job status tracking
   - `SCRAPER_CALLBACK_SECRET` (optional) - For secure callbacks

3. **Trigger from your main app:**
   ```typescript
   // In your main app, trigger via GitHub API
   await fetch("https://api.github.com/repos/YOUR_USERNAME/web-scraper-service/dispatches", {
     method: "POST",
     headers: {
       Accept: "application/vnd.github+json",
       Authorization: `Bearer ${GITHUB_TOKEN}`,
     },
     body: JSON.stringify({
       event_type: "scrape",
       client_payload: {
         urls_json: JSON.stringify(["https://example.com"]),
         job_id: "unique-id",
         brand_slug: "mysite",
         callback_url: "https://your-app.com/api/scraper-callback",
       },
     }),
   });
   ```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Your Main Application                        │
│  (Private Repository - Next.js/React/etc.)                      │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                │ 1. Trigger GitHub Action
                                │    (repository_dispatch)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Web Scraper Service (This Repo)                  │
│  (Public Repository - Can be forked/shared)                     │
│                                                                   │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│   │   Cheerio   │    │  Puppeteer  │    │   Upstash   │        │
│   │   Scraper   │    │   Scraper   │    │   Indexer   │        │
│   └─────────────┘    └─────────────┘    └─────────────┘        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                │ 2. Index to Upstash Vector
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Upstash Vector DB                          │
│  (Shared between main app and scraper)                          │
└─────────────────────────────────────────────────────────────────┘
```

## CLI Options

| Option                       | Description                   | Default   |
| ---------------------------- | ----------------------------- | --------- |
| `--urls=<urls>`              | Comma-separated list of URLs  | -         |
| `--urls-json=<json>`         | JSON array of URLs            | -         |
| `--brand=<slug>`             | Brand identifier for indexing | `default` |
| `--job-id=<id>`              | Job ID for tracking           | -         |
| `--engine=<engine>`          | `cheerio` or `puppeteer`      | `cheerio` |
| `--concurrency=<n>`          | Parallel requests             | `3`       |
| `--callback-url=<url>`       | URL to notify on completion   | -         |
| `--callback-secret=<secret>` | Auth secret for callback      | -         |

## Environment Variables

| Variable                    | Required | Description                            |
| --------------------------- | -------- | -------------------------------------- |
| `UPSTASH_VECTOR_REST_URL`   | Yes      | Upstash Vector REST URL                |
| `UPSTASH_VECTOR_REST_TOKEN` | Yes      | Upstash Vector REST Token              |
| `UPSTASH_REDIS_REST_URL`    | No       | Redis URL for job tracking             |
| `UPSTASH_REDIS_REST_TOKEN`  | No       | Redis token for job tracking           |
| `SCRAPER_ENGINE`            | No       | Default engine (`cheerio`/`puppeteer`) |
| `SCRAPER_CONCURRENCY`       | No       | Default concurrency                    |
| `CALLBACK_URL`              | No       | Default callback URL                   |
| `CALLBACK_SECRET`           | No       | Default callback secret                |

## Scrapers

### Cheerio Scraper ⚡ (Recommended)

Fast, lightweight scraping using `fetch` + Cheerio. Works great for:

- Static HTML websites
- Server-side rendered content
- Most traditional websites
- **Memory:** 2GB heap limit

### Puppeteer Scraper 🎭

Full browser-based scraping for JavaScript-heavy sites:

- Single Page Applications (SPAs)
- React/Vue/Angular apps
- Dynamic content loading
- Infinite scroll pages
- **Memory:** 4GB heap limit

## Memory Configuration

The scraper service is configured with appropriate memory limits to handle large-scale scraping:

- **Cheerio:** 2GB heap (`--max-old-space-size=2048`)
- **Puppeteer:** 4GB heap (`--max-old-space-size=4096`)
- **Garbage Collection:** Enabled with `--expose-gc` for manual memory management

### Troubleshooting Memory Issues

If you encounter "JavaScript heap out of memory" errors:

1. **Reduce concurrency:** Lower the `--concurrency` parameter

   ```bash
   npm run scrape -- --urls="..." --brand=mysite --concurrency=2
   ```

2. **Process URLs in smaller batches:** Split large URL lists into multiple jobs

3. **Increase memory limits:** Edit the `NODE_OPTIONS` in:
   - `.github/workflows/scrape.yml` (for GitHub Actions)
   - `package.json` scripts (for local development)

4. **Use Cheerio instead of Puppeteer:** Puppeteer requires more memory due to the browser instance

## Callback Payload

When scraping completes, a POST request is sent to the callback URL:

```json
{
  "jobId": "abc123",
  "status": "completed",
  "indexed": 45,
  "failed": 3,
  "total": 48
}
```

## Integrating with Your Main App

See the trigger API route in your main app (`/api/setup/trigger`) for an example of how to trigger this service and track job status.

## License

MIT
