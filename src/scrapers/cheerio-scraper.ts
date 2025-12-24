/**
 * Cheerio-based Web Scraper
 *
 * Uses fetch + Cheerio to scrape web content.
 * Works on serverless environments and GitHub Actions.
 *
 * Note: This won't capture JavaScript-rendered content.
 * For JS-heavy sites, use the Puppeteer scraper.
 */

import * as cheerio from "cheerio";
import type { ScrapedContent, ScrapeOptions } from "../types.js";

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) {
        throw lastError;
      }

      // Don't retry on certain errors
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('403') || message.includes('401') || message.includes('404')) {
          throw error; // Don't retry auth or not found errors
        }
      }

      // Exponential backoff with jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      console.log(`   ⏳ Retry attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }

  throw lastError!;
}

/**
 * Scrape a single URL using fetch + Cheerio
 */
export async function scrapeWithCheerio(
  url: string,
  timeout = 15000
): Promise<ScrapedContent | null> {
  try {
    console.log(`📄 Scraping (Cheerio): ${url}`);

    // Add random delay to avoid rate limiting (1-3 seconds)
    const delay = Math.random() * 2000 + 1000;
    await sleep(delay);

    // Randomize user agent to avoid detection
    const userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/121.0",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    ];
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    // Generate more realistic referer based on URL
    const getReferer = (targetUrl: string) => {
      try {
        const urlObj = new URL(targetUrl);
        // For product pages, refer from the main site
        if (targetUrl.includes('/product/')) {
          return `${urlObj.protocol}//${urlObj.host}/`;
        }
        // For blog pages, refer from home
        if (targetUrl.includes('/when-should-') || targetUrl.includes('/blog')) {
          return `${urlObj.protocol}//${urlObj.host}/`;
        }
        // For other pages, sometimes refer from search engines
        const referers = [
          `${urlObj.protocol}//${urlObj.host}/`,
          "https://www.google.com/",
          "https://www.bing.com/",
          undefined, // Sometimes no referer
        ];
        return referers[Math.floor(Math.random() * referers.length)];
      } catch {
        return undefined;
      }
    };

    const referer = getReferer(url);

    const response = await retryWithBackoff(async () => {
      const headers: Record<string, string> = {
        "User-Agent": randomUserAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "max-age=0",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        DNT: "1",
        // Additional headers to appear more like a real browser
        "Sec-Ch-Ua-Arch": '"x86"',
        "Sec-Ch-Ua-Bitness": '"64"',
        "Sec-Ch-Ua-Full-Version": '"120.0.6099.109"',
        "Sec-Ch-Ua-Full-Version-List": '"Not_A Brand";v="8.0.0.0", "Chromium";v="120.0.6099.109", "Google Chrome";v="120.0.6099.109"',
        "Sec-Ch-Ua-Model": '""',
        "Sec-Ch-Ua-Platform-Version": '"10.0.0"',
      };

      // Add referer conditionally
      if (referer) {
        headers.Referer = referer;
      }

      return await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeout),
      });
    });

    if (!response.ok) {
      console.error(`   ❌ HTTP ${response.status}: ${url}`);
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove non-content elements (but keep navigation and headers for better coverage)
    $(
      "script, style, iframe, noscript, .cookie-banner, .popup, .modal, .advertisement, .ad"
    ).remove();

    // Get title
    const title = $("title").text().trim() || $("h1").first().text().trim() || "Untitled Page";

    // Get meta description
    const description = $('meta[name="description"]').attr("content") || "";

    // Extract text from body
    const contentElement = $("body");
    const paragraphs: string[] = [];

    contentElement.find("*").each((_, elem) => {
      const $elem = $(elem);
      let directText = "";

      $elem.contents().each((_, node) => {
        if (node.type === "text") {
          directText += $(node).text();
        }
      });

      const text = directText
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 10 && /[a-zA-Z]{2,}/.test(text)) {
        paragraphs.push(text);
      }
    });

    // Deduplicate and join
    const uniqueParagraphs = Array.from(new Set(paragraphs));
    let content = uniqueParagraphs.join(" ");

    // Clean up and limit size
    content = content.replace(/\s+/g, " ").trim().slice(0, 100000);

    // Extract images (PNG, JPEG, WEBP - not SVG)
    const images: Array<{ src: string; alt?: string; title?: string }> = [];
    const validImageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"];
    const invalidPatterns = [
      "grey-box",
      "placeholder",
      "spacer",
      "blank",
      "transparent",
      "1x1",
      "pixel",
      "loading",
      "spinner",
      "logo-small",
      "favicon",
    ];

    $("img, picture source, [style*='background-image']").each((_, elem) => {
      // Try multiple attributes
      let src =
        $(elem).attr("src") ||
        $(elem).attr("data-src") ||
        $(elem).attr("data-lazy-src") ||
        $(elem).attr("srcset")?.split(",")[0]?.split(" ")[0] ||
        $(elem).attr("data-srcset")?.split(",")[0]?.split(" ")[0];

      // Extract from background-image CSS
      if (!src) {
        const style = $(elem).attr("style");
        const bgMatch = style?.match(/background-image:\s*url\(['"]?([^'"]+)['"]?\)/);
        if (bgMatch) src = bgMatch[1];
      }

      if (src && (src.startsWith("http") || src.startsWith("/") || src.startsWith("data:"))) {
        try {
          const absoluteURL = src.startsWith("data:") ? src : new URL(src, url).href;
          const urlLower = absoluteURL.toLowerCase();

          // Skip SVG images
          if (
            urlLower.includes(".svg") ||
            urlLower.includes("/svg/") ||
            urlLower.includes("data:image/svg")
          )
            return;

          // Skip invalid patterns
          const isInvalidImage = invalidPatterns.some((pattern) =>
            urlLower.includes(pattern.toLowerCase())
          );
          if (isInvalidImage) return;

          // Check for valid extensions (PNG, JPEG, WEBP)
          const hasValidExtension = validImageExtensions.some((ext) => urlLower.includes(ext));
          const isDataUrlImage =
            urlLower.startsWith("data:image/") && !urlLower.startsWith("data:image/svg");

          if (hasValidExtension || isDataUrlImage) {
            // Avoid duplicates
            if (!images.find((img) => img.src === absoluteURL)) {
              images.push({
                src: absoluteURL,
                alt: $(elem).attr("alt") || undefined,
                title: $(elem).attr("title") || undefined,
              });
            }
          }
        } catch {
          // Skip invalid URLs
        }
      }
    });

    console.log(`   ✅ Title: ${title.slice(0, 50)}...`);
    console.log(`   📝 Content length: ${content.length} chars`);
    console.log(`   🖼️  Images found: ${images.length}`);

    return {
      url,
      title: title.split("|")[0].split("-")[0].trim(),
      content: description ? `${description}\n\n${content}` : content,
      description,
      timestamp: Date.now(),
      images: images.slice(0, 20),
    };
  } catch (error) {
    console.error(`   ❌ Error scraping ${url}:`, error);
    return null;
  }
}

/**
 * Scrape multiple URLs with Cheerio
 */
export async function scrapeMultipleUrls(
  urls: string[],
  options: ScrapeOptions = {}
): Promise<ScrapedContent[]> {
  const { concurrency = 3, timeout = 15000, onProgress } = options;
  const results: ScrapedContent[] = [];

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (url, index) => {
        if (onProgress) {
          onProgress(i + index + 1, urls.length, url);
        }
        return scrapeWithCheerio(url, timeout);
      })
    );

    results.push(...batchResults.filter((r): r is ScrapedContent => r !== null));

    // Longer delay between batches to avoid rate limiting (2-5 seconds)
    if (i + concurrency < urls.length) {
      const batchDelay = Math.random() * 3000 + 2000; // 2-5 seconds
      await new Promise((resolve) => setTimeout(resolve, batchDelay));
    }
  }

  return results;
}
