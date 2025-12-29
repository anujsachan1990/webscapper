/**
 * Redis Job Status Tracker (Lightweight REST API)
 *
 * Uses direct REST API calls to minimize memory usage.
 * Optional - only used when Redis is configured.
 */

import type { JobStatus } from "../types.js";

const TTL = 86400; // 24 hours

function getCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

/**
 * Execute Redis command via REST API
 */
async function redisCommand(command: string[]): Promise<unknown> {
  const creds = getCredentials();
  if (!creds) return null;

  try {
    const response = await fetch(creds.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      console.warn(`Redis command failed: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as { result?: unknown };
    return data.result;
  } catch (error) {
    console.warn("Redis command error:", error);
    return null;
  }
}

/**
 * Set a key with TTL
 */
async function setWithTTL(key: string, value: string | number): Promise<void> {
  await redisCommand(["SET", key, String(value), "EX", String(TTL)]);
}

/**
 * Get a key value
 */
async function get(key: string): Promise<string | null> {
  const result = await redisCommand(["GET", key]);
  return result as string | null;
}

/**
 * Mark job as started
 */
export async function markJobStarted(jobId: string, total: number): Promise<void> {
  const creds = getCredentials();
  if (!creds) {
    console.log("   ℹ️  Redis not configured. Job status tracking disabled.");
    return;
  }

  await Promise.all([
    setWithTTL(`scrape-job:${jobId}:status`, "running"),
    setWithTTL(`scrape-job:${jobId}:total`, total),
    setWithTTL(`scrape-job:${jobId}:indexed`, 0),
    setWithTTL(`scrape-job:${jobId}:failed`, 0),
    setWithTTL(`scrape-job:${jobId}:started_at`, new Date().toISOString()),
  ]);
}

/**
 * Mark job as completed
 */
export async function markJobCompleted(
  jobId: string,
  indexed: number,
  failed: number
): Promise<void> {
  const creds = getCredentials();
  if (!creds) return;

  const status = failed > indexed ? "failed" : "completed";

  await Promise.all([
    setWithTTL(`scrape-job:${jobId}:status`, status),
    setWithTTL(`scrape-job:${jobId}:indexed`, indexed),
    setWithTTL(`scrape-job:${jobId}:failed`, failed),
    setWithTTL(`scrape-job:${jobId}:completed_at`, new Date().toISOString()),
  ]);
}

/**
 * Get job status
 */
export async function getJobStatus(jobId: string): Promise<JobStatus | null> {
  const creds = getCredentials();
  if (!creds) return null;

  const [status, indexed, failed, total, startedAt, completedAt, error] = await Promise.all([
    get(`scrape-job:${jobId}:status`),
    get(`scrape-job:${jobId}:indexed`),
    get(`scrape-job:${jobId}:failed`),
    get(`scrape-job:${jobId}:total`),
    get(`scrape-job:${jobId}:started_at`),
    get(`scrape-job:${jobId}:completed_at`),
    get(`scrape-job:${jobId}:error`),
  ]);

  if (!status) return null;

  return {
    jobId,
    status: status as JobStatus["status"],
    indexed: parseInt(indexed || "0", 10),
    failed: parseInt(failed || "0", 10),
    total: parseInt(total || "0", 10),
    startedAt: startedAt ?? undefined,
    completedAt: completedAt ?? undefined,
    error: error ?? undefined,
  };
}

/**
 * Increment indexed count
 */
export async function incrementIndexed(jobId: string): Promise<void> {
  await redisCommand(["INCR", `scrape-job:${jobId}:indexed`]);
}

/**
 * Increment failed count
 */
export async function incrementFailed(jobId: string): Promise<void> {
  await redisCommand(["INCR", `scrape-job:${jobId}:failed`]);
}

/**
 * Mark chunk as completed and check if job is fully done
 */
export async function markChunkCompleted(
  jobId: string,
  chunkId: number,
  indexed: number,
  failed: number
): Promise<boolean> {
  const creds = getCredentials();
  if (!creds) return false;

  // Mark this chunk as completed
  await setWithTTL(`scrape-job:${jobId}:chunk_${chunkId}:completed`, "true");
  await setWithTTL(`scrape-job:${jobId}:chunk_${chunkId}:indexed`, indexed);
  await setWithTTL(`scrape-job:${jobId}:chunk_${chunkId}:failed`, failed);

  // Increment completed chunks counter
  const completedChunks = await redisCommand(["INCR", `scrape-job:${jobId}:chunks_completed`]);
  const totalChunks = await get(`scrape-job:${jobId}:chunks_total`);

  if (!totalChunks || !completedChunks) return false;

  const totalChunksNum = parseInt(totalChunks, 10);
  const completedChunksNum = completedChunks as number;

  console.log(`🧩 Chunk ${chunkId} completed. Progress: ${completedChunksNum}/${totalChunksNum} chunks`);

  // Check if all chunks are completed
  if (completedChunksNum >= totalChunksNum) {
    // All chunks done - finalize the job
    await finalizeJobAfterChunks(jobId);
    return true;
  }

  return false;
}

/**
 * Finalize job after all chunks are completed
 */
async function finalizeJobAfterChunks(jobId: string): Promise<void> {
  console.log(`🎉 All chunks completed for job ${jobId}. Finalizing...`);

  // Sum up all chunk results
  const totalChunks = await get(`scrape-job:${jobId}:chunks_total`);
  if (!totalChunks) return;

  let totalIndexed = 0;
  let totalFailed = 0;

  for (let i = 1; i <= parseInt(totalChunks, 10); i++) {
    const chunkIndexed = await get(`scrape-job:${jobId}:chunk_${i}:indexed`);
    const chunkFailed = await get(`scrape-job:${jobId}:chunk_${i}:failed`);

    totalIndexed += parseInt(chunkIndexed || "0", 10);
    totalFailed += parseInt(chunkFailed || "0", 10);
  }

  // Mark overall job as completed
  await markJobCompleted(jobId, totalIndexed, totalFailed);
}
