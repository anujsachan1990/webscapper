/**
 * Type definitions for the scraper service
 */

export interface ScrapedContent {
  url: string;
  title: string;
  content: string;
  description?: string;
  timestamp: number;
  images?: Array<{ src: string; alt?: string; title?: string }>;
}

export type ScraperEngine = "cheerio" | "puppeteer" | "firecrawl";

export interface ScrapeOptions {
  engine?: ScraperEngine;
  concurrency?: number;
  timeout?: number;
  onProgress?: (indexed: number, total: number, currentUrl: string) => void;
}

export interface IndexOptions {
  brandSlug: string;
  jobId?: string;
  /** Chunk size in characters (default: 1000) */
  chunkSize?: number;
  /** Overlap between chunks in characters (default: 200) */
  chunkOverlap?: number;
}

/**
 * Default chunking configuration (matches main app settings)
 */
export const DEFAULT_CHUNK_OPTIONS = {
  chunkSize: 1000,
  chunkOverlap: 200,
} as const;

export interface JobStatus {
  jobId: string;
  status: "pending" | "running" | "completed" | "failed";
  total: number;
  indexed: number;
  failed: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface CallbackPayload {
  jobId: string;
  status: "completed" | "failed";
  indexed: number;
  failed: number;
  total: number;
}
