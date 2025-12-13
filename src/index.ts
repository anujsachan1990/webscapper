#!/usr/bin/env node
/**
 * Web Scraper Service - Main Entry Point
 *
 * A standalone scraping service that can be run:
 * - Via CLI for local development
 * - Via GitHub Actions for production scraping
 *
 * Usage:
 *   npx tsx src/index.ts --urls="https://example.com,https://example.com/about" --brand=mysite
 *   npx tsx src/index.ts --urls-json='["https://example.com"]' --brand=mysite --job-id=abc123
 */

import "dotenv/config";
import { scrapeMultipleUrls } from "./scrapers/cheerio-scraper.js";
import { indexMultipleContents, validateCredentials } from "./indexer/upstash-indexer.js";
import { markJobStarted, markJobCompleted } from "./indexer/redis-status.js";
import type { CallbackPayload, ScrapedContent } from "./types.js";

// Dynamic import for Puppeteer to avoid loading it when using Cheerio
async function loadPuppeteerScraper() {
  const module = await import("./scrapers/puppeteer-scraper.js");
  return {
    scrapeMultipleUrls: module.scrapeMultipleUrls,
    closeBrowser: module.closeBrowser,
  };
}

interface CliArgs {
  urls?: string[];
  urlsJson?: string;
  brandSlug: string;
  jobId?: string;
  engine?: "cheerio" | "puppeteer";
  concurrency?: number;
  callbackUrl?: string;
  callbackSecret?: string;
}

/**
 * Parse command line arguments
 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: Partial<CliArgs> = {};

  for (const arg of args) {
    if (arg.startsWith("--urls=")) {
      parsed.urls = arg.slice(7).split(",").filter(Boolean);
    } else if (arg.startsWith("--urls-json=")) {
      parsed.urlsJson = arg.slice(12);
    } else if (arg.startsWith("--brand=")) {
      parsed.brandSlug = arg.slice(8);
    } else if (arg.startsWith("--job-id=")) {
      parsed.jobId = arg.slice(9);
    } else if (arg.startsWith("--engine=")) {
      parsed.engine = arg.slice(9) as "cheerio" | "puppeteer";
    } else if (arg.startsWith("--concurrency=")) {
      parsed.concurrency = parseInt(arg.slice(14), 10);
    } else if (arg.startsWith("--callback-url=")) {
      parsed.callbackUrl = arg.slice(15);
    } else if (arg.startsWith("--callback-secret=")) {
      parsed.callbackSecret = arg.slice(18);
    }
  }

  // Also check environment variables
  if (!parsed.urls && !parsed.urlsJson && process.env.URLS_JSON) {
    parsed.urlsJson = process.env.URLS_JSON;
  }
  if (!parsed.brandSlug && process.env.BRAND_SLUG) {
    parsed.brandSlug = process.env.BRAND_SLUG;
  }
  if (!parsed.jobId && process.env.JOB_ID) {
    parsed.jobId = process.env.JOB_ID;
  }
  if (!parsed.engine && process.env.SCRAPER_ENGINE) {
    parsed.engine = process.env.SCRAPER_ENGINE as "cheerio" | "puppeteer";
  }
  if (!parsed.callbackUrl && process.env.CALLBACK_URL) {
    parsed.callbackUrl = process.env.CALLBACK_URL;
  }
  if (!parsed.callbackSecret && process.env.CALLBACK_SECRET) {
    parsed.callbackSecret = process.env.CALLBACK_SECRET;
  }

  return {
    urls: parsed.urls,
    urlsJson: parsed.urlsJson,
    brandSlug: parsed.brandSlug || "default",
    jobId: parsed.jobId,
    engine: parsed.engine || "cheerio",
    concurrency: parsed.concurrency || 3,
    callbackUrl: parsed.callbackUrl,
    callbackSecret: parsed.callbackSecret,
  };
}

/**
 * Send callback to main app
 */
async function sendCallback(
  callbackUrl: string,
  callbackSecret: string | undefined,
  payload: CallbackPayload
): Promise<void> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (callbackSecret) {
      headers["Authorization"] = `Bearer ${callbackSecret}`;
    }

    const response = await fetch(callbackUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log(`✅ Callback sent successfully to ${callbackUrl}`);
    } else {
      console.error(`❌ Callback failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(`❌ Failed to send callback:`, error);
  }
}

/**
 * Main scraping function
 */
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🌐 Web Scraper Service");
  console.log("═══════════════════════════════════════════════════════════════");

  const args = parseArgs();

  // Parse URLs
  let urls: string[] = [];
  if (args.urls) {
    urls = args.urls;
  } else if (args.urlsJson) {
    try {
      urls = JSON.parse(args.urlsJson);
    } catch {
      console.error("❌ Failed to parse URLs JSON");
      process.exit(1);
    }
  }

  if (urls.length === 0) {
    console.error("❌ No URLs provided. Use --urls or --urls-json");
    console.log("\nUsage:");
    console.log('  npm run scrape -- --urls="https://example.com" --brand=mysite');
    console.log("  npm run scrape -- --urls-json='[\"https://example.com\"]' --brand=mysite");
    process.exit(1);
  }

  console.log(`\n📋 Configuration:`);
  console.log(`   Brand: ${args.brandSlug}`);
  console.log(`   Engine: ${args.engine}`);
  console.log(`   URLs: ${urls.length}`);
  console.log(`   Concurrency: ${args.concurrency}`);
  if (args.jobId) console.log(`   Job ID: ${args.jobId}`);
  if (args.callbackUrl) console.log(`   Callback: ${args.callbackUrl}`);

  // Validate Upstash credentials before starting
  if (!validateCredentials()) {
    console.error("\n❌ Upstash Vector credentials not found!");
    console.error(
      "   Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN environment variables."
    );
    console.error("   Create a .env file from env.example.txt or set them in your environment.");
    process.exit(1);
  }
  console.log(`   ✅ Upstash credentials: configured`);

  console.log("\n───────────────────────────────────────────────────────────────");
  console.log("  📥 Starting Scrape");
  console.log("───────────────────────────────────────────────────────────────\n");

  // Mark job as started
  if (args.jobId) {
    await markJobStarted(args.jobId, urls.length);
  }

  let scrapedContents: ScrapedContent[] = [];
  let indexed = 0;
  let failed = 0;

  try {
    // Scrape URLs
    const scrapeOptions = {
      concurrency: args.concurrency,
      onProgress: (current: number, total: number, url: string) => {
        console.log(`[${current}/${total}] Scraping: ${url}`);
      },
    };

    if (args.engine === "puppeteer") {
      // Dynamically load Puppeteer only when needed to save memory
      const puppeteerScraper = await loadPuppeteerScraper();
      scrapedContents = await puppeteerScraper.scrapeMultipleUrls(urls, scrapeOptions);
    } else {
      scrapedContents = await scrapeMultipleUrls(urls, scrapeOptions);
    }

    console.log(`\n✅ Scraped ${scrapedContents.length}/${urls.length} URLs`);

    console.log("\n───────────────────────────────────────────────────────────────");
    console.log("  📤 Indexing to Upstash Vector");
    console.log("───────────────────────────────────────────────────────────────\n");

    // Index scraped content
    const indexResult = await indexMultipleContents(scrapedContents, {
      brandSlug: args.brandSlug,
      jobId: args.jobId,
    });

    indexed = indexResult.totalIndexed;
    failed = urls.length - indexed;

    // Clear scraped contents from memory
    scrapedContents.length = 0;
    scrapedContents = [];

    // Force garbage collection
    if (global.gc) {
      global.gc();
    }

    console.log(`\n📊 Indexing Results:`);
    console.log(`   ✅ Indexed: ${indexed} pages (${indexResult.totalChunks} chunks)`);
    console.log(`   ❌ Failed: ${indexResult.failed} pages`);

    if (indexResult.errors.length > 0) {
      console.log(`\n⚠️  Errors:`);
      indexResult.errors.slice(0, 5).forEach((err) => console.log(`   - ${err}`));
    }
  } catch (error) {
    console.error("\n❌ Scraping failed:", error);
    failed = urls.length;
  } finally {
    // Cleanup Puppeteer if used
    if (args.engine === "puppeteer") {
      const puppeteerScraper = await loadPuppeteerScraper();
      await puppeteerScraper.closeBrowser();
    }
  }

  // Mark job as completed
  if (args.jobId) {
    await markJobCompleted(args.jobId, indexed, failed);
  }

  // Send callback
  if (args.callbackUrl) {
    await sendCallback(args.callbackUrl, args.callbackSecret, {
      jobId: args.jobId || "unknown",
      status: failed > indexed ? "failed" : "completed",
      indexed,
      failed,
      total: urls.length,
    });
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  ✨ Scraping Complete");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Exit with error code if more failed than succeeded
  process.exit(failed > indexed ? 1 : 0);
}

// Run main function
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
