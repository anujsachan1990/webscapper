/**
 * Scraper exports
 */

export * from "./cheerio-scraper.js";
export {
  scrapeWithPuppeteer,
  scrapeMultipleUrls as scrapeMultipleUrlsWithPuppeteer,
  closeBrowser,
} from "./puppeteer-scraper.js";
export {
  scrapeWithFirecrawl,
  scrapeMultipleUrlsWithFirecrawl,
  crawlWithFirecrawl,
  isFirecrawlConfigured,
} from "./firecrawl-scraper.js";
export {
  scrapeWithFirecrawlDocker,
  scrapeMultipleUrlsWithFirecrawlDocker,
  crawlWithFirecrawlDocker,
  isFirecrawlDockerConfigured,
  setFirecrawlDockerConfig,
  clearFirecrawlDockerConfig,
  testFirecrawlDockerConnection,
  type FirecrawlDockerScrapeOptions,
  type FirecrawlScrapeOptions,
  type CrawlOptions,
} from "./firecrawl-docker-scraper.js";
