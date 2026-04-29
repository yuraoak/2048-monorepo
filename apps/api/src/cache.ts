import Redis from "ioredis";

const url = process.env.REDIS_URL;

export const redis = url
  ? new Redis(url, { maxRetriesPerRequest: 3, enableOfflineQueue: false })
  : null;

if (redis) {
  redis.on("error", (err) => console.error("redis error:", err.message));
  redis.on("connect", () => console.log("redis connected"));
} else {
  console.log("REDIS_URL not set — cache disabled");
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    console.error("cache get failed:", err);
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSec);
  } catch (err) {
    console.error("cache set failed:", err);
  }
}

export async function cacheInvalidatePattern(pattern: string): Promise<void> {
  if (!redis) return;
  try {
    const stream = redis.scanStream({ match: pattern, count: 100 });
    const keys: string[] = [];
    for await (const chunk of stream as AsyncIterable<string[]>) {
      keys.push(...chunk);
    }
    if (keys.length) await redis.del(...keys);
  } catch (err) {
    console.error("cache invalidate failed:", err);
  }
}

// Fail-open: if Redis is unavailable we let the request through rather than 500.
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  if (!redis) return true;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    return count <= limit;
  } catch (err) {
    console.error("rate limit failed:", err);
    return true;
  }
}
