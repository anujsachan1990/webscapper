/**
 * Puppeteer-based Web Scraper
 *
 * Uses headless Chrome to scrape JavaScript-rendered content.
 * Ensures we capture dynamically loaded content from SPAs and modern websites.
 */

import type { Browser, Page } from "puppeteer";
import type { ScrapedContent, ScrapeOptions } from "../types.js";

let puppeteer: any;
let puppeteerExtra: any;
let StealthPlugin: any;
let browserInstance: any = null;

/**
 * Simulate human-like scrolling behavior
 */
async function simulateHumanScrolling(page: Page): Promise<void> {
  const randomDelay = (min: number, max: number) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

  try {
    // Get page height
    const pageHeight = await page.evaluate(() => document.body.scrollHeight);
    const viewportHeight = await page.evaluate(() => window.innerHeight);

    if (pageHeight <= viewportHeight) {
      return; // No scrolling needed
    }

    // Simulate multiple scroll actions like a human
    const scrollSteps = Math.min(5, Math.ceil(pageHeight / viewportHeight));

    for (let i = 0; i < scrollSteps; i++) {
      const scrollAmount = (pageHeight / scrollSteps) * (i + 1);

      await page.evaluate(
        (scrollTo) => {
          window.scrollTo({
            top: scrollTo,
            behavior: "smooth",
          });
        },
        Math.min(scrollAmount, pageHeight - viewportHeight)
      );

      // Random pause between scrolls (500ms - 2s)
      await new Promise((resolve) => setTimeout(resolve, randomDelay(500, 2000)));

      // Sometimes move mouse randomly
      if (Math.random() > 0.5) {
        const viewport = await page.viewport();
        if (viewport) {
          const x = Math.floor(Math.random() * viewport.width);
          const y = Math.floor(Math.random() * viewport.height);
          await page.mouse.move(x, y, { steps: 10 });
          await new Promise((resolve) => setTimeout(resolve, randomDelay(100, 500)));
        }
      }
    }

    // Final scroll to bottom and back up slightly (human behavior)
    await page.evaluate(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    });
    await new Promise((resolve) => setTimeout(resolve, randomDelay(1000, 2000)));

    await page.evaluate(() => {
      window.scrollTo({ top: document.body.scrollHeight * 0.8, behavior: "smooth" });
    });
    await new Promise((resolve) => setTimeout(resolve, randomDelay(500, 1000)));
  } catch (error) {
    console.warn(`   ⚠️  Error during human scrolling simulation:`, error);
  }
}

async function loadPuppeteer() {
  if (!puppeteer) {
    const puppeteerModule = await import("puppeteer");
    puppeteer = puppeteerModule.default || puppeteerModule;

    try {
      // Load puppeteer-extra and stealth plugin for better bot detection evasion
      // @ts-ignore - Optional dependency
      const puppeteerExtraModule = await import("puppeteer-extra");
      puppeteerExtra = puppeteerExtraModule.default || puppeteerExtraModule;

      // @ts-ignore - Optional dependency
      const stealthModule = await import("puppeteer-extra-plugin-stealth");
      StealthPlugin = stealthModule.default || stealthModule;

      // Use puppeteer-extra with stealth plugin
      puppeteerExtra.use(StealthPlugin());
      puppeteer = puppeteerExtra;
      console.log("✅ Using puppeteer-extra with stealth plugin for enhanced bot evasion");
    } catch (error) {
      console.log("⚠️  puppeteer-extra not available, using basic stealth measures");
    }
  }
}

/**
 * Get or create a shared browser instance with stealth settings
 */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.connected) {
    console.log("🚀 Launching headless browser with stealth settings...");

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
        // Let puppeteer-extra stealth plugin handle most stealth measures
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        "--no-first-run",
        "--mute-audio",
        "--disable-sync",
        "--disable-translate",
        "--hide-scrollbars",
        "--disable-default-apps",
        "--disable-infobars",
      ],
      ignoreHTTPSErrors: true,
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

    // Random user agents to avoid detection
    const userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
    ];
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    await page.setUserAgent(randomUserAgent);

    // Random viewport sizes to appear more human
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1536, height: 864 },
      { width: 1440, height: 900 },
    ];
    const randomViewport = viewports[Math.floor(Math.random() * viewports.length)];
    await page.setViewport(randomViewport);

    // puppeteer-extra-plugin-stealth handles automation indicator hiding automatically

    // Enhanced request interception with better filtering
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      const url = req.url();

      // Block unnecessary resources but allow what's needed for proper page loading
      if (["font", "media", "websocket", "other"].includes(resourceType)) {
        req.abort();
      } else if (url.includes("google-analytics.com") || url.includes("googletagmanager.com")) {
        req.abort(); // Block analytics that might detect bots
      } else {
        req.continue();
      }
    });

    // Simulate human-like behavior with random delays
    const randomDelay = (min: number, max: number) =>
      Math.floor(Math.random() * (max - min + 1)) + min;

    console.log(`   🤖 Simulating human behavior...`);

    // Navigate with human-like timing
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout,
      });

      // Random delay before interacting (1-3 seconds)
      await new Promise((resolve) => setTimeout(resolve, randomDelay(1000, 3000)));

      // Check if Cloudflare challenge is present
      const isCloudflareChallenge = await page.evaluate(() => {
        const bodyText = document.body?.innerText || "";
        return (
          bodyText.includes("Cloudflare") ||
          bodyText.includes("Verify you are human") ||
          bodyText.includes("Checking your browser") ||
          document.title.includes("Just a moment")
        );
      });

      if (isCloudflareChallenge) {
        console.log(`   🛡️  Cloudflare challenge detected, waiting for resolution...`);

        // Wait longer for Cloudflare to resolve (up to 30 seconds)
        let challengeResolved = false;
        let attempts = 0;
        const maxAttempts = 30;

        while (!challengeResolved && attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          attempts++;

          challengeResolved = await page.evaluate(() => {
            const bodyText = document.body?.innerText || "";
            return (
              !bodyText.includes("Verify you are human") &&
              !bodyText.includes("Checking your browser") &&
              !document.title.includes("Just a moment")
            );
          });

          if (attempts % 5 === 0) {
            console.log(`   ⏳ Still waiting for Cloudflare... (${attempts}s)`);
          }
        }

        if (!challengeResolved) {
          console.log(`   ❌ Cloudflare challenge not resolved within timeout`);
          return null;
        }

        console.log(`   ✅ Cloudflare challenge passed!`);
      }

      // Wait for network to be mostly idle
      await new Promise((resolve) => setTimeout(resolve, 3000)); // Wait for network activity to settle

      // Simulate human scrolling behavior
      await simulateHumanScrolling(page);

      // Random delay after scrolling (2-5 seconds)
      await new Promise((resolve) => setTimeout(resolve, randomDelay(2000, 5000)));
    } catch (navError) {
      console.error(`   ❌ Navigation error:`, navError);
      throw navError;
    }

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

      // Convert NodeList to array to avoid DOM mutation issues
      removeSelectors.forEach((selector) => {
        Array.from(document.querySelectorAll(selector)).forEach((el) => {
          if (el.parentNode) {
            el.parentNode.removeChild(el);
          }
        });
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
