/**
 * Puppeteer-based Web Scraper
 *
 * Uses headless Chrome to scrape JavaScript-rendered content.
 * Ensures we capture dynamically loaded content from SPAs and modern websites.
 */

import type { Browser, Page } from "puppeteer";
import type { ScrapedContent, ScrapeOptions } from "../types.js";

let puppeteer: typeof import("puppeteer");
let browserInstance: Browser | null = null;

async function loadPuppeteer() {
  if (!puppeteer) {
    puppeteer = (await import("puppeteer")).default;
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
  timeout = 30000
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

    // Block unnecessary resources
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      if (["image", "font", "media"].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout,
    });

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

      // Remove unwanted elements
      const removeSelectors = [
        "script",
        "style",
        "noscript",
        "iframe",
        "nav",
        "footer",
        "header",
        ".cookie-banner",
        ".popup",
        ".modal",
        ".advertisement",
        ".ad",
        "[role='banner']",
        "[role='navigation']",
        "[role='complementary']",
      ];

      removeSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => el.remove());
      });

      const mainContent =
        document.querySelector("main")?.textContent ||
        document.querySelector("article")?.textContent ||
        document.querySelector('[role="main"]')?.textContent ||
        document.body.textContent ||
        "";

      const content = mainContent.replace(/\s+/g, " ").trim().slice(0, 100000);

      return { title, description, content };
    });

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

    try {
      const imageElements = await page.$$eval("img", (imgs) =>
        imgs.map((img) => ({
          src: img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src"),
          alt: img.alt,
          title: img.title,
        }))
      );

      for (const img of imageElements) {
        if (img.src && (img.src.startsWith("http") || img.src.startsWith("/"))) {
          try {
            const absoluteURL = new URL(img.src, url).href;
            const urlLower = absoluteURL.toLowerCase();

            if (urlLower.includes(".svg") || urlLower.includes("/svg/")) continue;

            const isInvalidImage = invalidPatterns.some((pattern) =>
              urlLower.includes(pattern.toLowerCase())
            );
            if (isInvalidImage) continue;

            const hasValidExtension = validImageExtensions.some((ext) => urlLower.includes(ext));
            const isDataUrlImage =
              urlLower.startsWith("data:image/") && !urlLower.startsWith("data:image/svg");

            if (hasValidExtension || isDataUrlImage) {
              images.push({
                src: absoluteURL,
                alt: img.alt || undefined,
                title: img.title || undefined,
              });
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
  const { concurrency = 3, timeout = 30000, onProgress } = options;
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

