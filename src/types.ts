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
 * Dynamic vector DB credentials for BYOK (Bring Your Own Keys)
 * When provided, these override the environment variables
 */
export interface VectorDBCredentials {
  provider: "upstash" | "pinecone" | "weaviate";
  url: string;
  token: string;
  indexName?: string;
  namespace?: string;
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
  status: "completed" | "failed" | "progress";
  indexed: number;
  failed: number;
  total: number;
  /** Current batch number (for progress updates) */
  batchNumber?: number;
  /** URLs indexed in this batch (for progress updates) */
  batchUrls?: string[];
}

/**
 * Progress callback for incremental batch indexing
 * Called every N URLs with current progress
 */
export interface BatchProgressCallback {
  (progress: BatchProgress): Promise<void> | void;
}

/**
 * Progress information for a batch of indexed content
 */
export interface BatchProgress {
  /** Total URLs indexed so far */
  indexedCount: number;
  /** Total URLs failed so far */
  failedCount: number;
  /** Total chunks indexed so far */
  chunksIndexed: number;
  /** Current batch number */
  batchNumber: number;
  /** URLs indexed in this batch */
  batchUrls: string[];
  /** Errors from this batch (if any) */
  batchErrors: string[];
}

/**
 * Options for IncrementalBatchIndexer
 */
export interface IncrementalIndexerOptions extends IndexOptions {
  /** Number of URLs to buffer before indexing (default: 5) */
  batchSize?: number;
  /** Callback for progress updates */
  onProgress?: BatchProgressCallback;
  /** Callback URL for HTTP progress notifications */
  callbackUrl?: string;
  /** Secret for callback authentication */
  callbackSecret?: string;
}
