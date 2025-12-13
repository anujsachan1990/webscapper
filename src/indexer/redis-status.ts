/**
 * Redis Job Status Tracker
 *
 * Tracks scraping job status in Upstash Redis.
 * Optional - only used when Redis is configured.
 */

import { Redis } from "@upstash/redis";
import type { JobStatus } from "../types.js";

let redisClient: Redis | null = null;

function getRedis(): Redis | null {
  if (redisClient === null) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      console.log("   ℹ️  Redis not configured. Job status tracking disabled.");
      return null;
    }

    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

const TTL = 86400; // 24 hours

/**
 * Update job status in Redis
 */
export async function updateJobStatus(
  jobId: string,
  updates: Partial<JobStatus>
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const promises: Promise<unknown>[] = [];

  if (updates.status) {
    promises.push(
      redis.set(`scrape-job:${jobId}:status`, updates.status),
      redis.expire(`scrape-job:${jobId}:status`, TTL)
    );
  }

  if (updates.indexed !== undefined) {
    promises.push(
      redis.set(`scrape-job:${jobId}:indexed`, updates.indexed),
      redis.expire(`scrape-job:${jobId}:indexed`, TTL)
    );
  }

  if (updates.failed !== undefined) {
    promises.push(
      redis.set(`scrape-job:${jobId}:failed`, updates.failed),
      redis.expire(`scrape-job:${jobId}:failed`, TTL)
    );
  }

  if (updates.total !== undefined) {
    promises.push(
      redis.set(`scrape-job:${jobId}:total`, updates.total),
      redis.expire(`scrape-job:${jobId}:total`, TTL)
    );
  }

  if (updates.startedAt) {
    promises.push(
      redis.set(`scrape-job:${jobId}:started_at`, updates.startedAt),
      redis.expire(`scrape-job:${jobId}:started_at`, TTL)
    );
  }

  if (updates.completedAt) {
    promises.push(
      redis.set(`scrape-job:${jobId}:completed_at`, updates.completedAt),
      redis.expire(`scrape-job:${jobId}:completed_at`, TTL)
    );
  }

  if (updates.error) {
    promises.push(
      redis.set(`scrape-job:${jobId}:error`, updates.error),
      redis.expire(`scrape-job:${jobId}:error`, TTL)
    );
  }

  await Promise.all(promises);
}

/**
 * Get job status from Redis
 */
export async function getJobStatus(jobId: string): Promise<JobStatus | null> {
  const redis = getRedis();
  if (!redis) return null;

  const [status, indexed, failed, total, startedAt, completedAt, error] = await Promise.all([
    redis.get<string>(`scrape-job:${jobId}:status`),
    redis.get<number>(`scrape-job:${jobId}:indexed`),
    redis.get<number>(`scrape-job:${jobId}:failed`),
    redis.get<number>(`scrape-job:${jobId}:total`),
    redis.get<string>(`scrape-job:${jobId}:started_at`),
    redis.get<string>(`scrape-job:${jobId}:completed_at`),
    redis.get<string>(`scrape-job:${jobId}:error`),
  ]);

  if (!status) return null;

  return {
    jobId,
    status: status as JobStatus["status"],
    indexed: indexed ?? 0,
    failed: failed ?? 0,
    total: total ?? 0,
    startedAt: startedAt ?? undefined,
    completedAt: completedAt ?? undefined,
    error: error ?? undefined,
  };
}

/**
 * Mark job as started
 */
export async function markJobStarted(jobId: string, total: number): Promise<void> {
  await updateJobStatus(jobId, {
    status: "running",
    total,
    indexed: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
  });
}

/**
 * Mark job as completed
 */
export async function markJobCompleted(
  jobId: string,
  indexed: number,
  failed: number
): Promise<void> {
  await updateJobStatus(jobId, {
    status: failed > indexed ? "failed" : "completed",
    indexed,
    failed,
    completedAt: new Date().toISOString(),
  });
}

/**
 * Increment indexed count
 */
export async function incrementIndexed(jobId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  await redis.incr(`scrape-job:${jobId}:indexed`);
}

/**
 * Increment failed count
 */
export async function incrementFailed(jobId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  await redis.incr(`scrape-job:${jobId}:failed`);
}

