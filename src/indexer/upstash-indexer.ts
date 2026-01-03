/**
 * Upstash Vector Indexer (Lightweight REST API)
 *
 * Uses direct REST API calls instead of SDK to minimize memory usage.
 * Indexes scraped content into Upstash Vector database.
 *
 * Supports BYOK (Bring Your Own Keys):
 * - Dynamic credentials can be passed at runtime
 * - Falls back to environment variables if not provided
 */

import type { ScrapedContent, IndexOptions, VectorDBCredentials } from "../types.js";

// Cached credentials to avoid repeated env lookups
let cachedCredentials: { url: string; token: string } | null = null;

// Dynamic credentials set at runtime (for BYOK)
let dynamicCredentials: VectorDBCredentials | null = null;

/**
 * Set dynamic vector DB credentials for BYOK
 * Call this before indexing to override environment variables
 */
export function setDynamicCredentials(credentials: VectorDBCredentials | null): void {
  dynamicCredentials = credentials;
  // Clear cached credentials so new ones are used
  cachedCredentials = null;
  if (credentials) {
    console.log(`   🔑 Using dynamic ${credentials.provider} credentials (BYOK mode)`);
  }
}

/**
 * Get current dynamic credentials
 */
export function getDynamicCredentials(): VectorDBCredentials | null {
  return dynamicCredentials;
}

// Get Upstash credentials (supports both dynamic and env-based)
function getCredentials() {
  if (cachedCredentials) {
    return cachedCredentials;
  }

  // Priority 1: Dynamic credentials (BYOK)
  if (dynamicCredentials) {
    cachedCredentials = {
      url: dynamicCredentials.url,
      token: dynamicCredentials.token,
    };
    return cachedCredentials;
  }

  // Priority 2: Environment variables
  const url = process.env.UPSTASH_VECTOR_REST_URL;
  const token = process.env.UPSTASH_VECTOR_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Upstash Vector credentials not found. Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN or provide dynamic credentials."
    );
  }

  cachedCredentials = { url, token };
  return cachedCredentials;
}

/**
 * Validate credentials before starting indexing
 * Checks both dynamic and environment-based credentials
 */
export function validateCredentials(): boolean {
  try {
    getCredentials();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if using BYOK mode
 */
export function isUsingBYOK(): boolean {
  return dynamicCredentials !== null;
}

/**
 * Default chunking configuration (optimized for RAG quality)
 */
const DEFAULT_CHUNK_CONFIG = {
  chunkSize: 1000, // Smaller chunks for better precision
  chunkOverlap: 200, // 20% overlap for context preservation
  maxContentLength: 100000, // 100KB max content
  maxChunksPerPage: 50, // Allow more chunks for comprehensive indexing
  minChunkLength: 50, // Minimum viable chunk length
};

/**
 * Semantic separators for intelligent chunking (priority order)
 */
const SEMANTIC_SEPARATORS = [
  "\n\n", // Paragraph breaks (highest priority)
  "\n", // Line breaks
  ". ", // Sentence endings
  "! ", // Exclamation sentences
  "? ", // Question sentences
  "; ", // Semicolon breaks
  ", ", // Comma breaks
  " ", // Word breaks (fallback)
];

/**
 * Split content into semantic chunks with overlap for better RAG performance
 *
 * Improvements over basic chunking:
 * - Respects sentence and paragraph boundaries
 * - Configurable overlap to preserve context between chunks
 * - Smart boundary detection to avoid splitting mid-sentence
 */
function chunkContent(
  content: string,
  chunkSize = DEFAULT_CHUNK_CONFIG.chunkSize,
  chunkOverlap = DEFAULT_CHUNK_CONFIG.chunkOverlap
): string[] {
  const chunks: string[] = [];
  const trimmedContent = content.trim();

  // Limit total content to prevent memory issues
  const limitedContent = trimmedContent.slice(0, DEFAULT_CHUNK_CONFIG.maxContentLength);

  // If content is shorter than chunk size, return it as a single chunk
  if (limitedContent.length <= chunkSize) {
    if (limitedContent.length >= DEFAULT_CHUNK_CONFIG.minChunkLength) {
      return [limitedContent];
    }
    return [];
  }

  let currentIndex = 0;

  while (currentIndex < limitedContent.length) {
    let chunkEnd = Math.min(currentIndex + chunkSize, limitedContent.length);

    // If not the last chunk, try to break at a semantic boundary
    if (chunkEnd < limitedContent.length) {
      const minBreakPosition = currentIndex + chunkSize * 0.5; // Don't break too early
      let bestBreak = -1;

      // Try each separator in priority order
      for (const separator of SEMANTIC_SEPARATORS) {
        const breakPoint = limitedContent.lastIndexOf(separator, chunkEnd);
        if (breakPoint > minBreakPosition) {
          bestBreak = breakPoint + separator.length;
          break; // Use first (highest priority) separator found
        }
      }

      if (bestBreak > currentIndex) {
        chunkEnd = bestBreak;
      }
    }

    const chunk = limitedContent.slice(currentIndex, chunkEnd).trim();

    if (chunk.length >= DEFAULT_CHUNK_CONFIG.minChunkLength) {
      chunks.push(chunk);
    }

    // Move forward, accounting for overlap
    const nextIndex = chunkEnd - chunkOverlap;

    // Ensure we always make progress to prevent infinite loops
    if (nextIndex <= currentIndex) {
      currentIndex = chunkEnd;
    } else {
      currentIndex = nextIndex;
    }

    // Safety check: stop if we've created too many chunks
    if (chunks.length >= DEFAULT_CHUNK_CONFIG.maxChunksPerPage) {
      console.log(`   ⚠️  Content truncated at ${DEFAULT_CHUNK_CONFIG.maxChunksPerPage} chunks`);
      break;
    }
  }

  return chunks;
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

  try {
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const response = await fetch(`${url}/upsert-data`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(vectors),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Always consume response body to prevent memory leaks
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Upstash upsert failed: ${response.status} - ${responseText.substring(0, 200)}`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Upstash request timed out after 30 seconds");
    }
    throw error;
  }
}

/**
 * Prepare chunk text for embedding with context
 * Adds title and section information for better retrieval
 */
function prepareChunkForEmbedding(
  title: string,
  chunk: string,
  chunkIndex: number,
  totalChunks: number
): string {
  if (totalChunks <= 1) {
    return `${title}\n\n${chunk}`;
  }
  // Add section context for multi-chunk documents
  return `${title}\n\n[Section ${chunkIndex + 1} of ${totalChunks}]\n\n${chunk}`;
}

/**
 * Index a single piece of scraped content
 */
export async function indexContent(
  content: ScrapedContent,
  options: IndexOptions
): Promise<{ success: boolean; chunksIndexed: number; error?: string }> {
  try {
    const {
      brandSlug,
      chunkSize = DEFAULT_CHUNK_CONFIG.chunkSize,
      chunkOverlap = DEFAULT_CHUNK_CONFIG.chunkOverlap,
    } = options;

    // Combine title, description, and content for chunking
    const fullContent = [content.description, content.content].filter(Boolean).join("\n\n");

    // Chunk the content using semantic chunking
    const chunks = chunkContent(fullContent, chunkSize, chunkOverlap);

    if (chunks.length === 0) {
      console.log(`   ⚠️  No valid chunks for: ${content.url}`);
      return { success: true, chunksIndexed: 0 };
    }

    console.log(`   📦 Processing ${chunks.length} chunks for: ${content.url}`);

    // Process chunks one at a time to minimize memory
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Prepare text for embedding with title and section context
      const textToEmbed = prepareChunkForEmbedding(content.title, chunk, i, chunks.length);

      // Build metadata with images (only on first chunk to avoid duplication)
      const metadata: Record<string, unknown> = {
        url: content.url,
        title: content.title,
        brandSlug,
        chunkIndex: i,
        totalChunks: chunks.length,
        timestamp: content.timestamp,
        contentPreview: chunk.slice(0, 500), // Store preview in metadata
      };

      // Add images to first chunk only
      if (i === 0 && content.images && content.images.length > 0) {
        metadata.images = JSON.stringify(content.images.slice(0, 5)); // Limit to 5 images
        metadata.imageCount = content.images.length;
      }

      // Add description if available
      if (content.description) {
        metadata.description = content.description;
      }

      const vector = {
        id: generateChunkId(content.url, i, brandSlug),
        data: textToEmbed, // Use prepared text with context
        metadata,
      };

      await upsertVectors([vector]);

      // Small delay between chunks to avoid rate limiting
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 50));
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

  // Process in small batches to manage memory
  const batchSize = 5;

  for (let i = 0; i < contents.length; i += batchSize) {
    const batch = contents.slice(i, i + batchSize);

    for (const content of batch) {
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

    // Force garbage collection after each batch
    if (global.gc) {
      global.gc();
    }

    // Small delay between batches to allow GC
    if (i + batchSize < contents.length) {
      await new Promise((r) => setTimeout(r, 100));
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
