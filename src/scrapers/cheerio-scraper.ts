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
 * Scrape a single URL using fetch + Cheerio
 */
export async function scrapeWithCheerio(
  url: string,
  timeout = 15000
): Promise<ScrapedContent | null> {
  try {
    console.log(`📄 Scraping (Cheerio): ${url}`);

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      console.error(`   ❌ HTTP ${response.status}: ${url}`);
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove non-content elements
    $(
      "script, style, iframe, noscript, .cookie-banner, .popup, .modal" +
        '[role="navigation"], [role="banner"]'
    ).remove();

    // Get title
    const title =
      $("title").text().trim() || $("h1").first().text().trim() || "Untitled Page";

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

    // Extract images
    const images: Array<{ src: string; alt?: string; title?: string }> = [];
    const validImageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".ico"];
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
      "icon",
      "svg",
      "/icons/",
      "/svg/",
    ];

    $("img").each((_, elem) => {
      const src =
        $(elem).attr("src") || $(elem).attr("data-src") || $(elem).attr("data-lazy-src");
      if (src && (src.startsWith("http") || src.startsWith("/"))) {
        try {
          const absoluteURL = new URL(src, url).href;
          const urlLower = absoluteURL.toLowerCase();

          if (urlLower.includes(".svg") || urlLower.includes("/svg/")) return;

          const isInvalidImage = invalidPatterns.some((pattern) =>
            urlLower.includes(pattern.toLowerCase())
          );
          if (isInvalidImage) return;

          const hasValidExtension = validImageExtensions.some((ext) => urlLower.includes(ext));
          const isDataUrlImage =
            urlLower.startsWith("data:image/") && !urlLower.startsWith("data:image/svg");

          if (hasValidExtension || isDataUrlImage) {
            images.push({
              src: absoluteURL,
              alt: $(elem).attr("alt") || undefined,
              title: $(elem).attr("title") || undefined,
            });
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

    // Small delay between batches
    if (i + concurrency < urls.length) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  return results;
}

