/**
 * Puppeteer-based Web Scraper
 *
 * Uses headless Chrome to scrape JavaScript-rendered content.
 * Ensures we capture dynamically loaded content from SPAs and modern websites.
 */

import type { Browser, Page } from "puppeteer";
import type { ScrapedContent, ScrapeOptions } from "../types.js";

let puppeteer: any;
let browserInstance: Browser | null = null;

async function loadPuppeteer() {
  if (!puppeteer) {
    const puppeteerModule = await import("puppeteer");
    puppeteer = puppeteerModule.default || puppeteerModule;
  }
}

/**
 * Get or create a shared browser instance
 */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.connected) {
    console.log("🚀 Launching headless browser...");

    await loadPuppeteer();

    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920,1080",
      ],
    });
  }
  return browserInstance!;
}

/**
 * Close the browser instance
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
    console.log("🔒 Browser closed");
  }
}

/**
 * Scrape a single URL using Puppeteer
 */
export async function scrapeWithPuppeteer(
  url: string,
  timeout = 60000 // Increased default timeout to 60 seconds
): Promise<ScrapedContent | null> {
  let page: Page | null = null;

  try {
    console.log(`📄 Scraping (Puppeteer): ${url}`);

    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    );

    await page.setViewport({ width: 1920, height: 1080 });

    // Block only unnecessary resources (keep images for extraction)
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      // Only block fonts and media (videos/audio), but allow images
      if (["font", "media"].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Try with networkidle2 first, fall back to domcontentloaded if timeout
    try {
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout,
      });
    } catch (navError) {
      // If networkidle2 times out, retry with less strict wait condition
      if (navError instanceof Error && navError.message.includes("timeout")) {
        console.log(`   ⚠️  networkidle2 timeout, retrying with domcontentloaded...`);
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout,
        });
        // Give some time for JS to execute
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } else {
        throw navError;
      }
    }

    // Scroll to trigger lazy loading
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        window.scrollTo(0, document.body.scrollHeight / 2);
        setTimeout(() => {
          window.scrollTo(0, document.body.scrollHeight);
          setTimeout(resolve, 1000);
        }, 500);
      });
    });

    // Extract content
    const result = await page.evaluate(() => {
      const title = document.title || document.querySelector("h1")?.textContent || "Untitled";

      const metaDesc = document.querySelector('meta[name="description"]');
      const description = metaDesc?.getAttribute("content") || "";

      // Remove unwanted elements (but keep nav, header, footer for better coverage)
      const removeSelectors = [
        "script",
        "style",
        "noscript",
        "iframe",
        ".cookie-banner",
        ".popup",
        ".modal",
        ".advertisement",
        ".ad",
      ];

      removeSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => el.remove());
      });

      // Extract table data first (preserving structure)
      const tableData: string[] = [];
      document.querySelectorAll("table").forEach((table) => {
        const rows: string[] = [];

        // Extract headers
        const headers: string[] = [];
        table.querySelectorAll("thead th, thead td, tr:first-child th").forEach((th) => {
          const headerText = (th.textContent || "")
            .replace(/[\r\n\t]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (headerText) headers.push(headerText);
        });
        if (headers.length > 0) {
          rows.push("Headers: " + headers.join(" | "));
        }

        // Extract body rows
        table.querySelectorAll("tbody tr, tr").forEach((tr) => {
          const cells: string[] = [];
          tr.querySelectorAll("td, th").forEach((cell) => {
            const cellText = (cell.textContent || "")
              .replace(/[\r\n\t]+/g, " ")
              .replace(/\s+/g, " ")
              .trim();
            if (cellText) cells.push(cellText);
          });
          if (cells.length > 0) {
            rows.push(cells.join(" | "));
          }
        });

        if (rows.length > 0) {
          tableData.push("Table: " + rows.join(" | Row: "));
        }
      });

      // Extract text content more comprehensively
      const paragraphs: string[] = [];
      document.querySelectorAll("*").forEach((elem) => {
        // Skip table elements as we handle them separately
        if (elem.closest("table")) return;

        let directText = "";
        elem.childNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            directText += node.textContent || "";
          }
        });

        const text = directText
          .replace(/[\r\n\t]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        // More permissive: include text with 3+ chars that has some meaningful content
        // This captures percentages, numbers with units, etc.
        if (
          text.length >= 3 &&
          (/[a-zA-Z]{2,}/.test(text) || // Has alphabetic content
            /\d+\.?\d*%/.test(text) || // Has percentage
            /\$[\d,]+/.test(text) || // Has currency
            /\d+\.?\d*\s*(years?|months?|days?|%|p\.a\.|pa)/i.test(text)) // Has numeric with unit
        ) {
          paragraphs.push(text);
        }
      });

      // Combine table data with regular paragraphs
      const allContent = [...tableData, ...paragraphs];

      // Deduplicate and join
      const uniqueParagraphs = Array.from(new Set(allContent));
      const content = uniqueParagraphs.join(" ").slice(0, 100000);

      return { title, description, content };
    });

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

    try {
      const imageElements = await page.evaluate(() => {
        const results: Array<{ src: string; alt?: string; title?: string }> = [];

        // Get images from img tags
        document.querySelectorAll("img").forEach((img) => {
          const src =
            img.src ||
            img.getAttribute("data-src") ||
            img.getAttribute("data-lazy-src") ||
            img.getAttribute("srcset")?.split(",")[0]?.split(" ")[0];

          if (src) {
            results.push({
              src,
              alt: img.alt || undefined,
              title: img.title || undefined,
            });
          }
        });

        // Get images from picture source tags
        document.querySelectorAll("picture source").forEach((source) => {
          const src =
            source.getAttribute("srcset")?.split(",")[0]?.split(" ")[0] ||
            source.getAttribute("data-srcset")?.split(",")[0]?.split(" ")[0];

          if (src) {
            results.push({ src });
          }
        });

        // Get background images from CSS
        document.querySelectorAll("[style*='background-image']").forEach((elem) => {
          const style = elem.getAttribute("style");
          const bgMatch = style?.match(/background-image:\s*url\(['"]?([^'"]+)['"]?\)/);
          if (bgMatch?.[1]) {
            results.push({ src: bgMatch[1] });
          }
        });

        return results;
      });

      for (const img of imageElements) {
        if (
          img.src &&
          (img.src.startsWith("http") || img.src.startsWith("/") || img.src.startsWith("data:"))
        ) {
          try {
            const absoluteURL = img.src.startsWith("data:") ? img.src : new URL(img.src, url).href;
            const urlLower = absoluteURL.toLowerCase();

            // Skip SVG images
            if (
              urlLower.includes(".svg") ||
              urlLower.includes("/svg/") ||
              urlLower.includes("data:image/svg")
            )
              continue;

            // Skip invalid patterns
            const isInvalidImage = invalidPatterns.some((pattern) =>
              urlLower.includes(pattern.toLowerCase())
            );
            if (isInvalidImage) continue;

            // Check for valid extensions (PNG, JPEG, WEBP)
            const hasValidExtension = validImageExtensions.some((ext) => urlLower.includes(ext));
            const isDataUrlImage =
              urlLower.startsWith("data:image/") && !urlLower.startsWith("data:image/svg");

            if (hasValidExtension || isDataUrlImage) {
              // Avoid duplicates
              if (!images.find((i) => i.src === absoluteURL)) {
                images.push({
                  src: absoluteURL,
                  alt: img.alt || undefined,
                  title: img.title || undefined,
                });
              }
            }
          } catch {
            // Skip invalid URLs
          }
        }
      }
    } catch (error) {
      console.warn(`   ⚠️  Error extracting images:`, error);
    }

    console.log(`   ✅ Title: ${result.title.slice(0, 50)}...`);
    console.log(`   📝 Content length: ${result.content.length} chars`);
    console.log(`   🖼️  Images found: ${images.length}`);

    return {
      url,
      title: result.title.split("|")[0].split("-")[0].trim(),
      content: `${result.description}\n\n${result.content}`,
      description: result.description,
      timestamp: Date.now(),
      images: images.slice(0, 20),
    };
  } catch (error) {
    console.error(`   ❌ Error scraping ${url}:`, error);
    return null;
  } finally {
    if (page) {
      await page.close();
    }
  }
}

/**
 * Scrape multiple URLs with Puppeteer
 */
export async function scrapeMultipleUrls(
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
        return scrapeWithPuppeteer(url, timeout);
      })
    );

    results.push(...batchResults.filter((r): r is ScrapedContent => r !== null));

    // Small delay between batches
    if (i + concurrency < urls.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  await closeBrowser();
  return results;
}
