/**
 * Firecrawl Docker Web Scraper
 *
 * Uses a self-hosted Firecrawl instance (via Docker) for LLM-optimized content extraction.
 * This enables unlimited scraping without cloud API credit limits.
 *
 * Features:
 * - Scrape individual URLs via self-hosted Firecrawl
 * - Crawl entire websites when sitemap is not available
 * - BYOK support - users can provide their own Firecrawl Docker URL
 * - Full JavaScript rendering support via Playwright microservice
 * - Retry logic with exponential backoff for reliability
 *
 * Configuration:
 * - FIRECRAWL_DOCKER_URL: Base URL of the self-hosted Firecrawl instance (e.g., http://localhost:3002)
 * - FIRECRAWL_DOCKER_API_KEY: Optional API key if the instance requires authentication
 */

import type { ScrapedContent, ScrapeOptions } from "../types.js";

// Default to localhost if not configured (for GitHub Actions with service containers)
const DEFAULT_FIRECRAWL_DOCKER_URL = "http://localhost:3002";

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10000;

interface FirecrawlDockerConfig {
  baseUrl: string;
  apiKey?: string;
}

interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: {
      title?: string;
      description?: string;
      ogImage?: string;
      language?: string;
      sourceURL?: string;
    };
  };
  error?: string;
}

interface FirecrawlCrawlResponse {
  success: boolean;
  id?: string;
  error?: string;
}

interface FirecrawlCrawlStatusResponse {
  success: boolean;
  status: "scraping" | "completed" | "failed";
  total?: number;
  completed?: number;
  creditsUsed?: number;
  expiresAt?: string;
  data?: Array<{
    markdown?: string;
    html?: string;
    metadata?: {
      title?: string;
      description?: string;
      ogImage?: string;
      language?: string;
      sourceURL?: string;
    };
  }>;
  error?: string;
}

export interface CrawlOptions {
  maxPages?: number;
  includePaths?: string[];
  excludePaths?: string[];
  pollInterval?: number;
  maxPollTime?: number;
  onProgress?: (completed: number, total: number, status: string) => void;
}

export interface FirecrawlScrapeOptions {
  waitForJs?: boolean; // Wait for JavaScript content to load
  waitTime?: number; // Time to wait for JS content (ms)
  onlyMainContent?: boolean; // Extract only main content
  removeScripts?: boolean; // Remove script tags from output
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function getRetryDelay(attempt: number): number {
  const delay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
  // Add jitter (±25%)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.floor(delay + jitter);
}

/**
 * Check if an error is retryable (connection issues, timeouts, 5xx errors)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Connection errors
    if (
      message.includes("econnrefused") ||
      message.includes("econnreset") ||
      message.includes("etimedout") ||
      message.includes("fetch failed") ||
      message.includes("network")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an HTTP status code is retryable
 */
function isRetryableStatus(status: number): boolean {
  // Retry on server errors (5xx) and rate limiting (429)
  return status >= 500 || status === 429;
}

// Dynamic configuration storage for BYOK
let dynamicConfig: FirecrawlDockerConfig | null = null;

/**
 * Set dynamic Firecrawl Docker configuration (for BYOK)
 */
export function setFirecrawlDockerConfig(config: FirecrawlDockerConfig): void {
  dynamicConfig = config;
  console.log(`🔥 Firecrawl Docker config set: ${config.baseUrl}`);
}

/**
 * Clear dynamic configuration (reset to environment variables)
 */
export function clearFirecrawlDockerConfig(): void {
  dynamicConfig = null;
}

/**
 * Get current Firecrawl Docker configuration
 */
function getConfig(): FirecrawlDockerConfig {
  if (dynamicConfig) {
    return dynamicConfig;
  }

  return {
    baseUrl: process.env.FIRECRAWL_DOCKER_URL || DEFAULT_FIRECRAWL_DOCKER_URL,
    apiKey: process.env.FIRECRAWL_DOCKER_API_KEY,
  };
}

/**
 * Check if Firecrawl Docker is configured and accessible
 */
export function isFirecrawlDockerConfigured(): boolean {
  const config = getConfig();
  return !!config.baseUrl;
}

/**
 * Test connection to Firecrawl Docker instance with retries
 */
export async function testFirecrawlDockerConnection(): Promise<{
  success: boolean;
  error?: string;
  supportsJsRendering?: boolean;
}> {
  const config = getConfig();

  if (!config.baseUrl) {
    return {
      success: false,
      error: "FIRECRAWL_DOCKER_URL not configured",
    };
  }

  // Try up to 3 times with exponential backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getRetryDelay(attempt - 1);
        console.log(`   🔄 Connection test retry ${attempt}/2 (waiting ${delay}ms)...`);
        await sleep(delay);
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (config.apiKey) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
      }

      // Try to hit a simple test endpoint
      const response = await fetch(`${config.baseUrl}/v1/scrape`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: "https://httpbin.org/html",
          formats: ["markdown"],
          onlyMainContent: true,
          waitFor: 1000, // Test if JS rendering is supported
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        const result: FirecrawlScrapeResponse = await response.json();
        return {
          success: true,
          supportsJsRendering: result.success && !!result.data?.markdown,
        };
      }

      // 401/402 means service is up but auth is required - still counts as successful connection
      if (response.status === 401 || response.status === 402) {
        return {
          success: true,
          supportsJsRendering: true,
        };
      }

      if (isRetryableStatus(response.status) && attempt < 2) {
        continue; // Retry on 5xx errors
      }

      const errorText = await response.text();
      return {
        success: false,
        error: `Firecrawl Docker returned ${response.status}: ${errorText}`,
      };
    } catch (error) {
      if (isRetryableError(error) && attempt < 2) {
        continue; // Retry on connection errors
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : "Connection failed",
      };
    }
  }

  return {
    success: false,
    error: "All connection attempts failed",
  };
}

/**
 * Scrape a single URL using self-hosted Firecrawl Docker with retry logic
 *
 * @param url - The URL to scrape
 * @param timeout - Request timeout in milliseconds (default: 60000)
 * @param options - Additional scrape options for JavaScript rendering
 * @returns Scraped content or null if failed
 */
export async function scrapeWithFirecrawlDocker(
  url: string,
  timeout = 60000,
  options: FirecrawlScrapeOptions = {}
): Promise<ScrapedContent | null> {
  const config = getConfig();

  if (!config.baseUrl) {
    console.error("❌ FIRECRAWL_DOCKER_URL not configured");
    return null;
  }

  const {
    waitForJs = true, // Enable JS rendering by default
    waitTime = 3000, // Wait 3s for JS content by default
    onlyMainContent = true,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getRetryDelay(attempt - 1);
        console.log(`   🔄 Retry ${attempt}/${MAX_RETRIES} for ${url} (waiting ${delay}ms)...`);
        await sleep(delay);
      } else {
        console.log(`🔥 Scraping (Firecrawl Docker): ${url}`);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (config.apiKey) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
      }

      // Build scrape request with JavaScript rendering options
      const scrapeRequest: Record<string, unknown> = {
        url,
        formats: ["markdown"],
        onlyMainContent,
      };

      // Enable JavaScript rendering if requested
      if (waitForJs) {
        scrapeRequest.waitFor = waitTime;
        // Additional options for JS-heavy sites
        scrapeRequest.actions = [
          { type: "wait", milliseconds: waitTime },
        ];
      }

      const response = await fetch(`${config.baseUrl}/v1/scrape`, {
        method: "POST",
        headers,
        body: JSON.stringify(scrapeRequest),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle retryable HTTP errors
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`   ❌ Firecrawl Docker API error: ${response.status} - ${errorText}`);

        if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
          lastError = new Error(`HTTP ${response.status}: ${errorText}`);
          continue; // Retry
        }
        return null;
      }

      const result: FirecrawlScrapeResponse = await response.json();

      if (!result.success || !result.data) {
        console.error(`   ❌ Firecrawl Docker failed: ${result.error || "Unknown error"}`);
        return null;
      }

      const { data } = result;
      const title = data.metadata?.title || "Untitled";
      const description = data.metadata?.description || "";
      const content = data.markdown || "";

      console.log(`   ✅ Title: ${title.slice(0, 50)}...`);
      console.log(`   📝 Content length: ${content.length} chars`);

      // Extract images from markdown (basic extraction)
      const images: Array<{ src: string; alt?: string }> = [];
      const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
      let match;
      while ((match = imageRegex.exec(content)) !== null) {
        const [, alt, src] = match;
        if (src && src.startsWith("http")) {
          images.push({ src, alt: alt || undefined });
        }
      }

      // Also add og:image if available
      if (data.metadata?.ogImage) {
        images.unshift({ src: data.metadata.ogImage, alt: "Open Graph Image" });
      }

      console.log(`   🖼️  Images found: ${images.length}`);

      return {
        url,
        title: title.split("|")[0].split("-")[0].trim(),
        content: `${description}\n\n${content}`,
        description,
        timestamp: Date.now(),
        images: images.slice(0, 20),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (error instanceof Error && error.name === "AbortError") {
        console.error(`   ❌ Firecrawl Docker timeout for ${url}`);
        // Timeouts are retryable
        if (attempt < MAX_RETRIES) {
          continue;
        }
      } else if (isRetryableError(error) && attempt < MAX_RETRIES) {
        console.error(`   ⚠️ Connection error (will retry): ${lastError.message}`);
        continue;
      } else {
        console.error(`   ❌ Error scraping ${url} with Firecrawl Docker:`, error);
      }

      // Final attempt failed
      if (attempt === MAX_RETRIES) {
        console.error(`   ❌ All ${MAX_RETRIES + 1} attempts failed for ${url}`);
      }
    }
  }

  return null;
}

/**
 * Extended scrape options for Firecrawl Docker
 */
export interface FirecrawlDockerScrapeOptions extends ScrapeOptions {
  waitForJs?: boolean; // Enable JavaScript rendering (default: true)
  waitTime?: number; // Time to wait for JS content in ms (default: 3000)
  testConnectionFirst?: boolean; // Test connection before scraping (default: true)
}

/**
 * Scrape multiple URLs with Firecrawl Docker
 *
 * @param urls - Array of URLs to scrape
 * @param options - Scrape options including JavaScript rendering settings
 * @returns Array of successfully scraped content
 */
export async function scrapeMultipleUrlsWithFirecrawlDocker(
  urls: string[],
  options: FirecrawlDockerScrapeOptions = {}
): Promise<ScrapedContent[]> {
  const {
    concurrency = 3,
    timeout = 60000,
    onProgress,
    waitForJs = true,
    waitTime = 3000,
    testConnectionFirst = true,
  } = options;

  // Optionally test connection first to fail fast
  if (testConnectionFirst) {
    console.log("🔥 Testing Firecrawl Docker connection...");
    const connectionTest = await testFirecrawlDockerConnection();
    if (!connectionTest.success) {
      console.error(`❌ Firecrawl Docker connection failed: ${connectionTest.error}`);
      console.log("⚠️ Returning empty results - consider falling back to another scraper");
      return [];
    }
    console.log(
      `✅ Firecrawl Docker connected (JS rendering: ${connectionTest.supportsJsRendering ? "enabled" : "unknown"})`
    );
  }

  const results: ScrapedContent[] = [];

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (url, index) => {
        if (onProgress) {
          onProgress(i + index, urls.length, url);
        }
        return scrapeWithFirecrawlDocker(url, timeout, {
          waitForJs,
          waitTime,
          onlyMainContent: true,
        });
      })
    );

    results.push(...batchResults.filter((r): r is ScrapedContent => r !== null));

    // Small delay between batches to respect rate limits
    if (i + concurrency < urls.length) {
      await sleep(500);
    }
  }

  console.log(`📊 Firecrawl Docker: ${results.length}/${urls.length} URLs scraped successfully`);
  return results;
}

/**
 * Crawl an entire website using self-hosted Firecrawl Docker
 * Use this when sitemap.xml is not available
 *
 * @param baseUrl - The starting URL to crawl from
 * @param options - Crawl options (maxPages, includePaths, excludePaths, etc.)
 * @returns Array of scraped content from discovered pages
 */
export async function crawlWithFirecrawlDocker(
  baseUrl: string,
  options: CrawlOptions = {}
): Promise<ScrapedContent[]> {
  const config = getConfig();

  if (!config.baseUrl) {
    console.error("❌ FIRECRAWL_DOCKER_URL not configured");
    return [];
  }

  const {
    maxPages = 50,
    includePaths = [],
    excludePaths = ["/blog/*", "/news/*", "/press/*"],
    pollInterval = 5000,
    maxPollTime = 600000, // 10 minutes max (self-hosted can take longer)
    onProgress,
  } = options;

  try {
    console.log(`🔥 Starting Firecrawl Docker crawl: ${baseUrl}`);
    console.log(`   Max pages: ${maxPages}`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    // Start the crawl job
    const crawlResponse = await fetch(`${config.baseUrl}/v1/crawl`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: baseUrl,
        limit: maxPages,
        scrapeOptions: {
          formats: ["markdown"],
          onlyMainContent: true,
        },
        ...(includePaths.length > 0 && { includePaths }),
        ...(excludePaths.length > 0 && { excludePaths }),
      }),
    });

    if (!crawlResponse.ok) {
      const errorText = await crawlResponse.text();
      console.error(`   ❌ Firecrawl Docker crawl API error: ${crawlResponse.status} - ${errorText}`);
      return [];
    }

    const crawlResult: FirecrawlCrawlResponse = await crawlResponse.json();

    if (!crawlResult.success || !crawlResult.id) {
      console.error(`   ❌ Firecrawl Docker crawl failed: ${crawlResult.error || "Unknown error"}`);
      return [];
    }

    const crawlId = crawlResult.id;
    console.log(`   📋 Crawl job started: ${crawlId}`);

    // Poll for completion
    const startTime = Date.now();
    let status: FirecrawlCrawlStatusResponse | null = null;

    while (Date.now() - startTime < maxPollTime) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      const statusResponse = await fetch(`${config.baseUrl}/v1/crawl/${crawlId}`, {
        headers,
      });

      if (!statusResponse.ok) {
        console.error(`   ⚠️ Error checking crawl status: ${statusResponse.status}`);
        continue;
      }

      status = await statusResponse.json();

      if (onProgress && status) {
        onProgress(status.completed || 0, status.total || 0, status.status);
      }

      console.log(
        `   ⏳ Crawl status: ${status?.status} (${status?.completed || 0}/${status?.total || 0} pages)`
      );

      if (status?.status === "completed") {
        break;
      }

      if (status?.status === "failed") {
        console.error(`   ❌ Crawl failed: ${status.error || "Unknown error"}`);
        return [];
      }
    }

    if (!status || status.status !== "completed") {
      console.error(`   ❌ Crawl timed out or did not complete`);
      return [];
    }

    // Process results
    const results: ScrapedContent[] = [];

    if (status.data && Array.isArray(status.data)) {
      console.log(`   ✅ Crawl completed: ${status.data.length} pages found`);

      for (const page of status.data) {
        const title = page.metadata?.title || "Untitled";
        const description = page.metadata?.description || "";
        const content = page.markdown || "";
        const sourceUrl = page.metadata?.sourceURL || baseUrl;

        if (content.length < 100) {
          continue; // Skip pages with very little content
        }

        // Extract images from markdown
        const images: Array<{ src: string; alt?: string }> = [];
        const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        let match;
        while ((match = imageRegex.exec(content)) !== null) {
          const [, alt, src] = match;
          if (src && src.startsWith("http")) {
            images.push({ src, alt: alt || undefined });
          }
        }

        if (page.metadata?.ogImage) {
          images.unshift({ src: page.metadata.ogImage, alt: "Open Graph Image" });
        }

        results.push({
          url: sourceUrl,
          title: title.split("|")[0].split("-")[0].trim(),
          content: `${description}\n\n${content}`,
          description,
          timestamp: Date.now(),
          images: images.slice(0, 20),
        });
      }
    }

    console.log(`   📊 Processed ${results.length} pages with content`);
    return results;
  } catch (error) {
    console.error(`   ❌ Error crawling ${baseUrl} with Firecrawl Docker:`, error);
    return [];
  }
}
