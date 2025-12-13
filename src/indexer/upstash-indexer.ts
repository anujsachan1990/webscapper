/**
 * Upstash Vector Indexer (Lightweight REST API)
 *
 * Uses direct REST API calls instead of SDK to minimize memory usage.
 * Indexes scraped content into Upstash Vector database.
 */

import type { ScrapedContent, IndexOptions } from "../types.js";

// Get Upstash credentials
function getCredentials() {
  const url = process.env.UPSTASH_VECTOR_REST_URL;
  const token = process.env.UPSTASH_VECTOR_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Upstash Vector credentials not found. Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN."
    );
  }

  return { url, token };
}

/**
 * Split content into chunks for vector storage
 */
function chunkContent(content: string, chunkSize = 800, chunkOverlap = 100): string[] {
  const chunks: string[] = [];
  let start = 0;

  // Limit total content to prevent memory issues
  const limitedContent = content.slice(0, 50000);

  while (start < limitedContent.length) {
    const end = Math.min(start + chunkSize, limitedContent.length);
    const chunk = limitedContent.slice(start, end).trim();

    if (chunk.length > 50) {
      chunks.push(chunk);
    }

    start = end - chunkOverlap;
    if (start >= limitedContent.length - 50) break;
  }

  // Limit number of chunks per page
  return chunks.slice(0, 20);
}

/**
 * Generate a unique ID for a chunk
 */
function generateChunkId(url: string, chunkIndex: number, brandSlug: string): string {
  const urlHash = url
    .replace(/https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]/g, "-")
    .slice(0, 50);
  return `${brandSlug}_${urlHash}_chunk_${chunkIndex}`;
}

/**
 * Upsert vectors using REST API (lightweight)
 */
async function upsertVectors(
  vectors: Array<{
    id: string;
    data: string;
    metadata: Record<string, unknown>;
  }>
): Promise<void> {
  const { url, token } = getCredentials();

  const response = await fetch(`${url}/upsert-data`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(vectors),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upstash upsert failed: ${response.status} - ${error}`);
  }
}

/**
 * Index a single piece of scraped content
 */
export async function indexContent(
  content: ScrapedContent,
  options: IndexOptions
): Promise<{ success: boolean; chunksIndexed: number; error?: string }> {
  try {
    const { brandSlug, chunkSize = 800, chunkOverlap = 100 } = options;

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

    console.log(`   📦 Processing ${chunks.length} chunks for: ${content.url}`);

    // Process chunks one at a time to minimize memory
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const vector = {
        id: generateChunkId(content.url, i, brandSlug),
        data: chunk,
        metadata: {
          url: content.url,
          title: content.title,
          brandSlug,
          chunkIndex: i,
          totalChunks: chunks.length,
          timestamp: content.timestamp,
        },
      };

      await upsertVectors([vector]);

      // Small delay between chunks
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
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

    // Force garbage collection hint
    if (global.gc) {
      global.gc();
    }
  }

  return { totalIndexed, totalChunks, failed, errors };
}

/**
 * Get index statistics
 */
export async function getIndexStats(): Promise<{
  totalVectors: number;
  dimension: number;
}> {
  const { url, token } = getCredentials();

  const response = await fetch(`${url}/info`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get index info: ${response.status}`);
  }

  const data = (await response.json()) as { result?: { vectorCount?: number; dimension?: number } };
  return {
    totalVectors: data.result?.vectorCount || 0,
    dimension: data.result?.dimension || 0,
  };
}
