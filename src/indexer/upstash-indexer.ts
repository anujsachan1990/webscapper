/**
 * Upstash Vector Indexer
 *
 * Indexes scraped content into Upstash Vector database.
 * Handles chunking, embedding, and upsert operations.
 */

import { Index } from "@upstash/vector";
import type { ScrapedContent, IndexOptions } from "../types.js";

// Upstash Vector client (initialized lazily)
let vectorIndex: Index | null = null;

function getVectorIndex(): Index {
  if (!vectorIndex) {
    const url = process.env.UPSTASH_VECTOR_REST_URL;
    const token = process.env.UPSTASH_VECTOR_REST_TOKEN;

    if (!url || !token) {
      throw new Error(
        "Upstash Vector credentials not found. Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN."
      );
    }

    vectorIndex = new Index({ url, token });
  }
  return vectorIndex;
}

/**
 * Split content into chunks for vector storage
 */
function chunkContent(
  content: string,
  chunkSize = 1000,
  chunkOverlap = 200
): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    const end = Math.min(start + chunkSize, content.length);
    const chunk = content.slice(start, end).trim();

    if (chunk.length > 50) {
      chunks.push(chunk);
    }

    start = end - chunkOverlap;
    if (start >= content.length - 50) break;
  }

  return chunks;
}

/**
 * Generate a unique ID for a chunk
 */
function generateChunkId(url: string, chunkIndex: number, brandSlug: string): string {
  // Create a simple hash from URL
  const urlHash = url
    .replace(/https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]/g, "-")
    .slice(0, 50);
  return `${brandSlug}_${urlHash}_chunk_${chunkIndex}`;
}

/**
 * Index a single piece of scraped content
 */
export async function indexContent(
  content: ScrapedContent,
  options: IndexOptions
): Promise<{ success: boolean; chunksIndexed: number; error?: string }> {
  try {
    const { brandSlug, chunkSize = 1000, chunkOverlap = 200 } = options;

    const index = getVectorIndex();

    // Combine title, description, and content
    const fullContent = [content.title, content.description, content.content]
      .filter(Boolean)
      .join("\n\n");

    // Chunk the content
    const chunks = chunkContent(fullContent, chunkSize, chunkOverlap);

    if (chunks.length === 0) {
      console.log(`   ⚠️  No valid chunks for: ${content.url}`);
      return { success: true, chunksIndexed: 0 };
    }

    // Prepare vectors for upsert
    const vectors = chunks.map((chunk, i) => ({
      id: generateChunkId(content.url, i, brandSlug),
      data: chunk, // Upstash will embed this automatically
      metadata: {
        url: content.url,
        title: content.title,
        brandSlug,
        chunkIndex: i,
        totalChunks: chunks.length,
        timestamp: content.timestamp,
      },
    }));

    // Upsert in batches of 100
    const batchSize = 100;
    for (let i = 0; i < vectors.length; i += batchSize) {
      const batch = vectors.slice(i, i + batchSize);
      await index.upsert(batch);
    }

    console.log(`   ✅ Indexed ${chunks.length} chunks for: ${content.url}`);
    return { success: true, chunksIndexed: chunks.length };
  } catch (error) {
    console.error(`   ❌ Failed to index ${content.url}:`, error);
    return {
      success: false,
      chunksIndexed: 0,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Index multiple pieces of content
 */
export async function indexMultipleContents(
  contents: ScrapedContent[],
  options: IndexOptions
): Promise<{
  totalIndexed: number;
  totalChunks: number;
  failed: number;
  errors: string[];
}> {
  let totalIndexed = 0;
  let totalChunks = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const content of contents) {
    const result = await indexContent(content, options);
    if (result.success) {
      totalIndexed++;
      totalChunks += result.chunksIndexed;
    } else {
      failed++;
      if (result.error) {
        errors.push(`${content.url}: ${result.error}`);
      }
    }
  }

  return { totalIndexed, totalChunks, failed, errors };
}

/**
 * Delete all vectors for a specific brand
 */
export async function deleteByBrand(brandSlug: string): Promise<void> {
  console.log(`🗑️  Deleting all vectors for brand: ${brandSlug}`);

  const index = getVectorIndex();

  // Note: Upstash Vector doesn't support metadata-based deletion directly
  // You would need to track IDs or use namespaces
  // For now, we'll log a warning
  console.warn(
    `   ⚠️  Bulk deletion by brand requires tracking IDs or using namespaces. ` +
      `Consider clearing the entire index or implementing ID tracking.`
  );
}

/**
 * Get index statistics
 */
export async function getIndexStats(): Promise<{
  totalVectors: number;
  dimension: number;
}> {
  const index = getVectorIndex();
  const info = await index.info();
  return {
    totalVectors: info.vectorCount,
    dimension: info.dimension,
  };
}

