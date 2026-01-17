/**
 * Incremental Batch Indexer
 *
 * Indexes content in small batches (default 5 URLs) as it's scraped,
 * rather than waiting until all scraping is complete.
 *
 * Benefits:
 * - Progress visibility: Users see updates every 5 URLs
 * - Fault tolerance: Only lose current batch if job fails
 * - Memory efficiency: Lower memory usage, only hold 5 items at a time
 * - Better UX: Immediate feedback during long-running jobs
 * - Resume capability: Can restart failed jobs from last successful batch
 */

import type {
  ScrapedContent,
  IncrementalIndexerOptions,
  BatchProgress,
  CallbackPayload,
} from "../types.js";
import { indexContent } from "./upstash-indexer.js";
import { updateJobProgress } from "./redis-status.js";

/** Default batch size for incremental indexing */
const DEFAULT_BATCH_SIZE = 5;

/**
 * IncrementalBatchIndexer - Indexes content in small batches as it's scraped
 */
export class IncrementalBatchIndexer {
  private buffer: ScrapedContent[] = [];
  private options: Required<
    Pick<IncrementalIndexerOptions, "brandSlug" | "batchSize">
  > &
    IncrementalIndexerOptions;

  // Cumulative stats across all batches
  private totalIndexed = 0;
  private totalFailed = 0;
  private totalChunks = 0;
  private batchNumber = 0;
  private allErrors: string[] = [];

  constructor(options: IncrementalIndexerOptions) {
    this.options = {
      ...options,
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    };

    console.log(
      `📦 IncrementalBatchIndexer initialized (batch size: ${this.options.batchSize})`
    );
  }

  /**
   * Add scraped content to the buffer
   * Automatically triggers indexing when buffer reaches batch size
   */
  async add(content: ScrapedContent): Promise<void> {
    this.buffer.push(content);

    if (this.buffer.length >= this.options.batchSize) {
      await this.flushBuffer();
    }
  }

  /**
   * Add multiple scraped contents to the buffer
   * Automatically triggers indexing when buffer reaches batch size
   */
  async addMultiple(contents: ScrapedContent[]): Promise<void> {
    for (const content of contents) {
      await this.add(content);
    }
  }

  /**
   * Flush the current buffer and index all pending content
   * Call this when scraping is complete to index any remaining items
   */
  async flush(): Promise<void> {
    if (this.buffer.length > 0) {
      await this.flushBuffer();
    }
  }

  /**
   * Internal method to index the current buffer
   */
  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;

    this.batchNumber++;
    const batch = [...this.buffer];
    this.buffer = []; // Clear buffer immediately to free memory

    console.log(
      `\n🔄 Batch ${this.batchNumber}: Indexing ${batch.length} URLs...`
    );

    const batchUrls: string[] = [];
    const batchErrors: string[] = [];
    let batchIndexed = 0;
    let batchChunks = 0;
    let batchFailed = 0;

    for (const content of batch) {
      try {
        const result = await indexContent(content, {
          brandSlug: this.options.brandSlug,
          jobId: this.options.jobId,
          chunkSize: this.options.chunkSize,
          chunkOverlap: this.options.chunkOverlap,
        });

        if (result.success) {
          batchIndexed++;
          batchChunks += result.chunksIndexed;
          batchUrls.push(content.url);
        } else {
          batchFailed++;
          if (result.error) {
            batchErrors.push(`${content.url}: ${result.error}`);
          }
        }
      } catch (error) {
        batchFailed++;
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        batchErrors.push(`${content.url}: ${errorMessage}`);
        console.error(`   ❌ Failed to index ${content.url}:`, error);
      }
    }

    // Update cumulative stats
    this.totalIndexed += batchIndexed;
    this.totalFailed += batchFailed;
    this.totalChunks += batchChunks;
    this.allErrors.push(...batchErrors);

    console.log(
      `   ✅ Batch ${this.batchNumber} complete: ${batchIndexed}/${batch.length} indexed (${batchChunks} chunks)`
    );
    console.log(
      `   📊 Total progress: ${this.totalIndexed} indexed, ${this.totalFailed} failed`
    );

    // Create progress object
    const progress: BatchProgress = {
      indexedCount: this.totalIndexed,
      failedCount: this.totalFailed,
      chunksIndexed: this.totalChunks,
      batchNumber: this.batchNumber,
      batchUrls,
      batchErrors,
    };

    // Call progress callback if provided
    if (this.options.onProgress) {
      try {
        await this.options.onProgress(progress);
      } catch (error) {
        console.warn("   ⚠️  Progress callback failed:", error);
      }
    }

    // Update Redis job status if job ID is provided
    if (this.options.jobId) {
      try {
        await updateJobProgress(
          this.options.jobId,
          this.totalIndexed,
          this.totalFailed,
          this.totalChunks
        );
      } catch (error) {
        console.warn("   ⚠️  Failed to update Redis status:", error);
      }
    }

    // Send HTTP callback if URL is provided
    if (this.options.callbackUrl) {
      await this.sendProgressCallback(progress);
    }

    // Force garbage collection after each batch
    if (global.gc) {
      global.gc();
    }
  }

  /**
   * Send progress callback via HTTP
   */
  private async sendProgressCallback(progress: BatchProgress): Promise<void> {
    if (!this.options.callbackUrl) return;

    try {
      const payload: CallbackPayload = {
        jobId: this.options.jobId || "unknown",
        status: "progress",
        indexed: progress.indexedCount,
        failed: progress.failedCount,
        total: progress.indexedCount + progress.failedCount,
        batchNumber: progress.batchNumber,
        batchUrls: progress.batchUrls,
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.options.callbackSecret) {
        headers["Authorization"] = `Bearer ${this.options.callbackSecret}`;
      }

      const response = await fetch(this.options.callbackUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        console.log(
          `   📞 Progress callback sent (batch ${progress.batchNumber})`
        );
      } else {
        console.warn(
          `   ⚠️  Progress callback failed: ${response.status} ${response.statusText}`
        );
      }
    } catch (error) {
      console.warn("   ⚠️  Failed to send progress callback:", error);
    }
  }

  /**
   * Get current stats
   */
  getStats(): {
    totalIndexed: number;
    totalFailed: number;
    totalChunks: number;
    batchCount: number;
    errors: string[];
    pendingCount: number;
  } {
    return {
      totalIndexed: this.totalIndexed,
      totalFailed: this.totalFailed,
      totalChunks: this.totalChunks,
      batchCount: this.batchNumber,
      errors: this.allErrors,
      pendingCount: this.buffer.length,
    };
  }

  /**
   * Check if there are pending items in the buffer
   */
  hasPending(): boolean {
    return this.buffer.length > 0;
  }

  /**
   * Get the number of pending items
   */
  getPendingCount(): number {
    return this.buffer.length;
  }
}

/**
 * Create an incremental batch indexer with the given options
 */
export function createIncrementalIndexer(
  options: IncrementalIndexerOptions
): IncrementalBatchIndexer {
  return new IncrementalBatchIndexer(options);
}
