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
import {
  validateCredentials,
  setDynamicCredentials,
  isUsingBYOK,
} from "./indexer/upstash-indexer.js";
import {
  markJobStarted,
  markJobCompleted,
  markChunkCompleted,
  markBatchCompleted,
} from "./indexer/redis-status.js";
import { IncrementalBatchIndexer } from "./indexer/incremental-batch-indexer.js";
import type { CallbackPayload, ScrapedContent, ScraperEngine, VectorDBCredentials } from "./types.js";

// Dynamic imports to avoid loading unused scrapers
async function loadPuppeteerScraper() {
  const module = await import("./scrapers/puppeteer-scraper.js");
  return {
    scrapeMultipleUrls: module.scrapeMultipleUrls,
    closeBrowser: module.closeBrowser,
  };
}

async function loadFirecrawlScraper() {
  const module = await import("./scrapers/firecrawl-scraper.js");
  return {
    scrapeMultipleUrls: module.scrapeMultipleUrlsWithFirecrawl,
    isConfigured: module.isFirecrawlConfigured,
  };
}

async function loadFirecrawlDockerScraper() {
  const module = await import("./scrapers/firecrawl-docker-scraper.js");
  return {
    scrapeMultipleUrls: module.scrapeMultipleUrlsWithFirecrawlDocker,
    isConfigured: module.isFirecrawlDockerConfigured,
    setConfig: module.setFirecrawlDockerConfig,
    testConnection: module.testFirecrawlDockerConnection,
  };
}

interface CliArgs {
  urls?: string[];
  urlsJson?: string;
  brandSlug: string;
  jobId?: string;
  engine?: ScraperEngine;
  concurrency?: number;
  timeout?: number;
  callbackUrl?: string;
  callbackSecret?: string;
  chunkId?: number;
  totalChunks?: number;
  // Chunking options (for RAG quality tuning)
  chunkSize?: number;
  chunkOverlap?: number;
  // Incremental indexing options
  indexBatchSize?: number;
  // BYOK Vector DB credentials (optional - overrides env vars)
  vectorDbProvider?: VectorDBCredentials["provider"];
  vectorDbUrl?: string;
  vectorDbToken?: string;
  vectorDbIndexName?: string;
  vectorDbNamespace?: string;
  // Firecrawl Docker configuration (optional - for self-hosted Firecrawl)
  firecrawlDockerUrl?: string;
  firecrawlDockerApiKey?: string;
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
      parsed.engine = arg.slice(9) as ScraperEngine;
    } else if (arg.startsWith("--concurrency=")) {
      parsed.concurrency = parseInt(arg.slice(14), 10);
    } else if (arg.startsWith("--callback-url=")) {
      parsed.callbackUrl = arg.slice(15);
    } else if (arg.startsWith("--callback-secret=")) {
      parsed.callbackSecret = arg.slice(18);
    } else if (arg.startsWith("--timeout=")) {
      parsed.timeout = parseInt(arg.slice(10), 10);
    } else if (arg.startsWith("--vector-db-provider=")) {
      parsed.vectorDbProvider = arg.slice(21) as VectorDBCredentials["provider"];
    } else if (arg.startsWith("--vector-db-url=")) {
      parsed.vectorDbUrl = arg.slice(16);
    } else if (arg.startsWith("--vector-db-token=")) {
      parsed.vectorDbToken = arg.slice(18);
    } else if (arg.startsWith("--vector-db-index=")) {
      parsed.vectorDbIndexName = arg.slice(18);
    } else if (arg.startsWith("--vector-db-namespace=")) {
      parsed.vectorDbNamespace = arg.slice(22);
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
    parsed.engine = process.env.SCRAPER_ENGINE as ScraperEngine;
  }
  if (!parsed.callbackUrl && process.env.CALLBACK_URL) {
    parsed.callbackUrl = process.env.CALLBACK_URL;
  }
  if (!parsed.callbackSecret && process.env.CALLBACK_SECRET) {
    parsed.callbackSecret = process.env.CALLBACK_SECRET;
  }
  if (!parsed.timeout && process.env.SCRAPE_TIMEOUT) {
    parsed.timeout = parseInt(process.env.SCRAPE_TIMEOUT, 10);
  }
  if (!parsed.chunkId && process.env.CHUNK_ID) {
    parsed.chunkId = parseInt(process.env.CHUNK_ID, 10);
  }
  if (!parsed.totalChunks && process.env.TOTAL_CHUNKS) {
    parsed.totalChunks = parseInt(process.env.TOTAL_CHUNKS, 10);
  }
  // Chunking configuration from environment
  if (!parsed.chunkSize && process.env.CHUNK_SIZE) {
    parsed.chunkSize = parseInt(process.env.CHUNK_SIZE, 10);
  }
  if (!parsed.chunkOverlap && process.env.CHUNK_OVERLAP) {
    parsed.chunkOverlap = parseInt(process.env.CHUNK_OVERLAP, 10);
  }
  // Incremental indexing batch size from environment
  if (!parsed.indexBatchSize && process.env.INDEX_BATCH_SIZE) {
    parsed.indexBatchSize = parseInt(process.env.INDEX_BATCH_SIZE, 10);
  }

  // BYOK Vector DB credentials from environment
  if (!parsed.vectorDbProvider && process.env.BYOK_VECTOR_DB_PROVIDER) {
    parsed.vectorDbProvider = process.env.BYOK_VECTOR_DB_PROVIDER as VectorDBCredentials["provider"];
  }
  if (!parsed.vectorDbUrl && process.env.BYOK_VECTOR_DB_URL) {
    parsed.vectorDbUrl = process.env.BYOK_VECTOR_DB_URL;
  }
  if (!parsed.vectorDbToken && process.env.BYOK_VECTOR_DB_TOKEN) {
    parsed.vectorDbToken = process.env.BYOK_VECTOR_DB_TOKEN;
  }
  if (!parsed.vectorDbIndexName && process.env.BYOK_VECTOR_DB_INDEX) {
    parsed.vectorDbIndexName = process.env.BYOK_VECTOR_DB_INDEX;
  }
  if (!parsed.vectorDbNamespace && process.env.BYOK_VECTOR_DB_NAMESPACE) {
    parsed.vectorDbNamespace = process.env.BYOK_VECTOR_DB_NAMESPACE;
  }

  // Firecrawl Docker configuration from environment
  if (!parsed.firecrawlDockerUrl && process.env.FIRECRAWL_DOCKER_URL) {
    parsed.firecrawlDockerUrl = process.env.FIRECRAWL_DOCKER_URL;
  }
  if (!parsed.firecrawlDockerApiKey && process.env.FIRECRAWL_DOCKER_API_KEY) {
    parsed.firecrawlDockerApiKey = process.env.FIRECRAWL_DOCKER_API_KEY;
  }

  return {
    urls: parsed.urls,
    urlsJson: parsed.urlsJson,
    brandSlug: parsed.brandSlug || "default",
    jobId: parsed.jobId,
    engine: parsed.engine || "cheerio",
    concurrency: parsed.concurrency || 3,
    timeout: parsed.timeout || 60000, // Default 60 seconds
    callbackUrl: parsed.callbackUrl,
    callbackSecret: parsed.callbackSecret,
    chunkId: parsed.chunkId,
    totalChunks: parsed.totalChunks,
    chunkSize: parsed.chunkSize || 1000, // Default 1000 chars (improved from 800)
    chunkOverlap: parsed.chunkOverlap || 200, // Default 200 chars overlap (20%)
    indexBatchSize: parsed.indexBatchSize || 5, // Default 5 URLs per batch for incremental indexing
    // BYOK credentials
    vectorDbProvider: parsed.vectorDbProvider,
    vectorDbUrl: parsed.vectorDbUrl,
    vectorDbToken: parsed.vectorDbToken,
    vectorDbIndexName: parsed.vectorDbIndexName,
    vectorDbNamespace: parsed.vectorDbNamespace,
    // Firecrawl Docker configuration
    firecrawlDockerUrl: parsed.firecrawlDockerUrl,
    firecrawlDockerApiKey: parsed.firecrawlDockerApiKey,
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
  console.log(`   Timeout: ${args.timeout}ms`);
  console.log(`   Chunk Size: ${args.chunkSize} chars`);
  console.log(`   Chunk Overlap: ${args.chunkOverlap} chars (${((args.chunkOverlap! / args.chunkSize!) * 100).toFixed(0)}%)`);
  console.log(`   Index Batch Size: ${args.indexBatchSize} URLs (incremental indexing)`);
  if (args.jobId) console.log(`   Job ID: ${args.jobId}`);
  if (args.chunkId && args.totalChunks) {
    console.log(`   Chunk: ${args.chunkId}/${args.totalChunks}`);
  }
  if (args.callbackUrl) console.log(`   Callback: ${args.callbackUrl}`);

  // Set up BYOK dynamic credentials if provided
  // Check if BYOK credentials are provided and valid (not empty strings)
  const byokUrl = args.vectorDbUrl?.trim() || "";
  const byokToken = args.vectorDbToken?.trim() || "";
  const hasByokUrl = byokUrl.length > 0;
  const hasByokToken = byokToken.length > 0;

  if (hasByokUrl && hasByokToken) {
    console.log(`   🔐 BYOK Mode detected:`);
    console.log(`      Provider: ${args.vectorDbProvider || "upstash"}`);
    console.log(`      URL: ${byokUrl.substring(0, 50)}...`);
    console.log(`      Token: ${byokToken.substring(0, 10)}...`);
    if (args.vectorDbIndexName) console.log(`      Index: ${args.vectorDbIndexName}`);
    if (args.vectorDbNamespace) console.log(`      Namespace: ${args.vectorDbNamespace}`);

    setDynamicCredentials({
      provider: args.vectorDbProvider || "upstash",
      url: byokUrl,
      token: byokToken,
      indexName: args.vectorDbIndexName,
      namespace: args.vectorDbNamespace,
    });
  } else if (hasByokUrl || hasByokToken) {
    // Partial BYOK config - warn but continue with defaults
    console.log(`   ⚠️  Partial BYOK config detected (missing ${!hasByokUrl ? "URL" : "token"})`);
    console.log(`   ⚠️  Falling back to default Upstash credentials`);
  }

  // Validate Vector DB credentials before starting
  if (!validateCredentials()) {
    console.error("\n❌ Vector DB credentials not found!");
    if (isUsingBYOK()) {
      console.error("   BYOK credentials were provided but appear to be invalid.");
    } else {
      console.error(
        "   Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN environment variables."
      );
      console.error("   Or provide BYOK credentials via --vector-db-url and --vector-db-token.");
    }
    console.error("   Create a .env file from env.example.txt or set them in your environment.");
    process.exit(1);
  }
  console.log(`   ✅ Vector DB credentials: configured ${isUsingBYOK() ? "(BYOK)" : "(env)"}`);

  console.log("\n───────────────────────────────────────────────────────────────");
  console.log("  📥 Starting Incremental Scrape & Index");
  console.log("───────────────────────────────────────────────────────────────\n");

  // Mark job as started (only for first chunk or non-chunked jobs)
  if (args.jobId && (!args.chunkId || args.chunkId === 1)) {
    await markJobStarted(args.jobId, urls.length);
  }

  // Create incremental batch indexer
  const indexer = new IncrementalBatchIndexer({
    brandSlug: args.brandSlug,
    jobId: args.jobId,
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
    batchSize: args.indexBatchSize,
    callbackUrl: args.callbackUrl,
    callbackSecret: args.callbackSecret,
    onProgress: async (progress) => {
      // Log progress and optionally update Redis
      console.log(
        `📊 Progress: ${progress.indexedCount} indexed, ${progress.failedCount} failed (batch ${progress.batchNumber})`
      );
      // Mark batch as completed for resume capability
      if (args.jobId) {
        await markBatchCompleted(args.jobId, progress.batchNumber, progress.batchUrls);
      }
    },
  });

  let indexed = 0;
  let failed = 0;
  let totalChunks = 0;

  try {
    // Scrape URLs in batches and index incrementally
    const scrapeOptions = {
      concurrency: args.concurrency,
      timeout: args.timeout,
      onProgress: (current: number, total: number, url: string) => {
        console.log(`[${current}/${total}] Scraping: ${url}`);
      },
    };

    // Process URLs in scrape batches (larger than index batches for efficiency)
    const scrapeBatchSize = Math.max(args.indexBatchSize! * 2, 10); // Scrape 10+ at a time
    let scrapedSoFar = 0;

    for (let i = 0; i < urls.length; i += scrapeBatchSize) {
      const urlBatch = urls.slice(i, i + scrapeBatchSize);
      console.log(
        `\n📥 Scraping batch ${Math.floor(i / scrapeBatchSize) + 1}: ${urlBatch.length} URLs...`
      );

      let scrapedContents: ScrapedContent[] = [];

      // Select scraper engine
      switch (args.engine) {
        case "puppeteer": {
          const puppeteerScraper = await loadPuppeteerScraper();
          scrapedContents = await puppeteerScraper.scrapeMultipleUrls(urlBatch, scrapeOptions);
          break;
        }
        case "firecrawl": {
          const firecrawlScraper = await loadFirecrawlScraper();
          if (!firecrawlScraper.isConfigured()) {
            console.error("❌ FIRECRAWL_API_KEY not configured. Falling back to Cheerio.");
            scrapedContents = await scrapeMultipleUrls(urlBatch, scrapeOptions);
          } else {
            console.log("🔥 Using Firecrawl for LLM-optimized scraping");
            scrapedContents = await firecrawlScraper.scrapeMultipleUrls(urlBatch, scrapeOptions);
          }
          break;
        }
        case "firecrawl-docker": {
          const firecrawlDockerScraper = await loadFirecrawlDockerScraper();
          // Set dynamic config if provided via BYOK
          if (args.firecrawlDockerUrl) {
            firecrawlDockerScraper.setConfig({
              baseUrl: args.firecrawlDockerUrl,
              apiKey: args.firecrawlDockerApiKey,
            });
          }
          if (!firecrawlDockerScraper.isConfigured()) {
            console.error("❌ FIRECRAWL_DOCKER_URL not configured. Falling back to Cheerio.");
            scrapedContents = await scrapeMultipleUrls(urlBatch, scrapeOptions);
          } else {
            console.log("🔥 Using Firecrawl Docker (self-hosted) for LLM-optimized scraping");
            scrapedContents = await firecrawlDockerScraper.scrapeMultipleUrls(urlBatch, scrapeOptions);
          }
          break;
        }
        case "cheerio":
        default:
          // Try Cheerio first (fast), then fallback to Puppeteer for failed URLs
          const cheerioResults = await scrapeMultipleUrls(urlBatch, scrapeOptions);
          scrapedContents = cheerioResults;

          // Check for 403 failures and retry with Puppeteer
          const failedUrls = urlBatch.filter(
            (url) => !cheerioResults.some((result) => result.url === url)
          );
          if (failedUrls.length > 0) {
            console.log(
              `\n🔄 ${failedUrls.length} URLs failed with Cheerio, retrying with Puppeteer...`
            );
            try {
              const puppeteerScraper = await loadPuppeteerScraper();
              const puppeteerResults = await puppeteerScraper.scrapeMultipleUrls(failedUrls, {
                ...scrapeOptions,
                concurrency: 1, // Lower concurrency for Puppeteer to avoid overwhelming
              });
              scrapedContents = [...cheerioResults, ...puppeteerResults];
              console.log(`✅ Puppeteer rescued ${puppeteerResults.length}/${failedUrls.length} URLs`);
            } catch (error) {
              console.log("⚠️  Puppeteer fallback failed:", error);
            }
          }
          break;
      }

      scrapedSoFar += scrapedContents.length;
      console.log(`✅ Scraped ${scrapedContents.length} URLs (${scrapedSoFar}/${urls.length} total)`);

      // Add scraped content to incremental indexer (auto-indexes every N URLs)
      console.log("\n📤 Indexing scraped content incrementally...");
      await indexer.addMultiple(scrapedContents);

      // Clear scraped contents from memory immediately
      scrapedContents.length = 0;
      scrapedContents = [];

      // Force garbage collection after each scrape batch
      if (global.gc) {
        global.gc();
      }
    }

    // Flush any remaining content in the indexer buffer
    await indexer.flush();

    // Get final stats
    const stats = indexer.getStats();
    indexed = stats.totalIndexed;
    failed = stats.totalFailed;
    totalChunks = stats.totalChunks;

    console.log("\n───────────────────────────────────────────────────────────────");
    console.log("  📊 Final Results");
    console.log("───────────────────────────────────────────────────────────────\n");
    console.log(`   ✅ Indexed: ${indexed} pages (${totalChunks} chunks)`);
    console.log(`   ❌ Failed: ${failed} pages`);
    console.log(`   📦 Batches processed: ${stats.batchCount}`);

    if (stats.errors.length > 0) {
      console.log(`\n⚠️  Errors:`);
      stats.errors.slice(0, 5).forEach((err) => console.log(`   - ${err}`));
    }
  } catch (error) {
    console.error("\n❌ Scraping failed:", error);
    // Get partial stats from indexer
    const stats = indexer.getStats();
    indexed = stats.totalIndexed;
    failed = urls.length - indexed;
    totalChunks = stats.totalChunks;
    console.log(`\n📊 Partial progress saved: ${indexed} pages indexed before failure`);
  } finally {
    // Cleanup Puppeteer if used
    if (args.engine === "puppeteer") {
      try {
        const puppeteerScraper = await loadPuppeteerScraper();
        await puppeteerScraper.closeBrowser();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  // Mark job as completed
  if (args.jobId) {
    if (args.chunkId && args.totalChunks && args.totalChunks > 1) {
      // Chunked processing - mark chunk as completed
      const isJobComplete = await markChunkCompleted(args.jobId, args.chunkId, indexed, failed);
      if (isJobComplete) {
        console.log(`\n🎉 All chunks completed! Job ${args.jobId} finalized.`);
      }
    } else {
      // Single job processing
      await markJobCompleted(args.jobId, indexed, failed);
    }
  }

  // Send callback (only for single jobs or when all chunks are complete)
  if (args.callbackUrl) {
    const isChunkedJob = args.chunkId && args.totalChunks && args.totalChunks > 1;

    if (!isChunkedJob) {
      // Single job - send callback immediately
      await sendCallback(args.callbackUrl, args.callbackSecret, {
        jobId: args.jobId || "unknown",
        status: failed > indexed ? "failed" : "completed",
        indexed,
        failed,
        total: urls.length,
      });
    } else {
      // Chunked job - callback is sent by the chunk completion function when all chunks are done
      console.log(`📞 Callback will be sent when all ${args.totalChunks} chunks complete`);
    }
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
