export interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  cacheScope?: "public" | "private";
}

export class McpCache {
  private cache = new Map<string, CacheEntry<any>>();

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set<T>(key: string, data: T, ttlMs: number, cacheScope?: "public" | "private"): void {
    // If cacheScope is private, we still cache it in-memory for the current client,
    // since toolconnector runs locally per-user anyway.
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
      cacheScope,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

export const mcpCache = new McpCache();
