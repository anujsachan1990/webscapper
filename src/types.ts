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

export interface ScrapeOptions {
  engine?: "cheerio" | "puppeteer";
  concurrency?: number;
  timeout?: number;
  onProgress?: (indexed: number, total: number, currentUrl: string) => void;
}

export interface IndexOptions {
  brandSlug: string;
  jobId?: string;
  chunkSize?: number;
  chunkOverlap?: number;
}

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
