/**
 * Firecrawl Web Scraper
 *
 * Uses Firecrawl API for LLM-optimized content extraction.
 * Returns clean markdown, handles JS-rendered content automatically.
 *
 * Features:
 * - Scrape individual URLs
 * - Crawl entire websites when sitemap is not available
 *
 * Requires FIRECRAWL_API_KEY environment variable.
 */

import type { ScrapedContent, ScrapeOptions } from "../types.js";

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1";

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

/**
 * Check if Firecrawl API key is configured
 */
export function isFirecrawlConfigured(): boolean {
  return !!process.env.FIRECRAWL_API_KEY;
}

/**
 * Scrape a single URL using Firecrawl
 */
export async function scrapeWithFirecrawl(
  url: string,
  timeout = 60000
): Promise<ScrapedContent | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;

  if (!apiKey) {
    console.error("❌ FIRECRAWL_API_KEY not configured");
    return null;
  }

  try {
    console.log(`🔥 Scraping (Firecrawl): ${url}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${FIRECRAWL_API_URL}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 2000, // Wait 2s for JS content
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`   ❌ Firecrawl API error: ${response.status} - ${errorText}`);
      return null;
    }

    const result: FirecrawlScrapeResponse = await response.json();

    if (!result.success || !result.data) {
      console.error(`   ❌ Firecrawl failed: ${result.error || "Unknown error"}`);
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
    if (error instanceof Error && error.name === "AbortError") {
      console.error(`   ❌ Firecrawl timeout for ${url}`);
    } else {
      console.error(`   ❌ Error scraping ${url} with Firecrawl:`, error);
    }
    return null;
  }
}

/**
 * Scrape multiple URLs with Firecrawl
 */
export async function scrapeMultipleUrlsWithFirecrawl(
  urls: string[],
  options: ScrapeOptions = {}
): Promise<ScrapedContent[]> {
  const { concurrency = 3, timeout = 60000, onProgress } = options;
  const results: ScrapedContent[] = [];

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (url, index) => {
        if (onProgress) {
          onProgress(i + index, urls.length, url);
        }
        return scrapeWithFirecrawl(url, timeout);
      })
    );

    results.push(...batchResults.filter((r): r is ScrapedContent => r !== null));

    // Small delay between batches to respect rate limits
    if (i + concurrency < urls.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return results;
}

/**
 * Crawl an entire website using Firecrawl
 * Use this when sitemap.xml is not available
 *
 * @param baseUrl - The starting URL to crawl from
 * @param options - Crawl options (maxPages, includePaths, excludePaths, etc.)
 * @returns Array of scraped content from discovered pages
 */
export async function crawlWithFirecrawl(
  baseUrl: string,
  options: CrawlOptions = {}
): Promise<ScrapedContent[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY;

  if (!apiKey) {
    console.error("❌ FIRECRAWL_API_KEY not configured");
    return [];
  }

  const {
    maxPages = 50,
    includePaths = [],
    excludePaths = ["/blog/*", "/news/*", "/press/*"],
    pollInterval = 5000,
    maxPollTime = 300000, // 5 minutes max
    onProgress,
  } = options;

  try {
    console.log(`🔥 Starting Firecrawl crawl: ${baseUrl}`);
    console.log(`   Max pages: ${maxPages}`);

    // Start the crawl job
    const crawlResponse = await fetch(`${FIRECRAWL_API_URL}/crawl`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
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
      console.error(`   ❌ Firecrawl crawl API error: ${crawlResponse.status} - ${errorText}`);
      return [];
    }

    const crawlResult: FirecrawlCrawlResponse = await crawlResponse.json();

    if (!crawlResult.success || !crawlResult.id) {
      console.error(`   ❌ Firecrawl crawl failed: ${crawlResult.error || "Unknown error"}`);
      return [];
    }

    const crawlId = crawlResult.id;
    console.log(`   📋 Crawl job started: ${crawlId}`);

    // Poll for completion
    const startTime = Date.now();
    let status: FirecrawlCrawlStatusResponse | null = null;

    while (Date.now() - startTime < maxPollTime) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      const statusResponse = await fetch(`${FIRECRAWL_API_URL}/crawl/${crawlId}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
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
    console.error(`   ❌ Error crawling ${baseUrl} with Firecrawl:`, error);
    return [];
  }
}
