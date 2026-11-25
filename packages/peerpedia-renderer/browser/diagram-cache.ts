/** Browser-only transport for the upstream compiler's content-addressed JSON cache. */
export interface CacheRequest {
  channel: "peerpedia-diagram-cache";
  id: number;
  operation: "get" | "set";
  key: string;
  value?: string;
}
export interface CacheResponse {
  channel: "peerpedia-diagram-cache";
  id: number;
  value?: string;
}
export function isCacheRequest(value: unknown): value is CacheRequest {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<CacheRequest>;
  return (
    item.channel === "peerpedia-diagram-cache" &&
    Number.isSafeInteger(item.id) &&
    typeof item.key === "string" &&
    /^[a-f0-9]{64}$/.test(item.key) &&
    (item.operation === "get" ||
      (item.operation === "set" && typeof item.value === "string"))
  );
}

/** Owned by the plugin, so successful diagrams survive worker idle shutdown. */
export class DiagramCache {
  private readonly entries = new Map<string, string>();
  private bytes = 0;
  constructor(
    private readonly maxBytes: number = 8 * 1024 * 1024,
    private readonly maxEntries: number = 128,
  ) {}
  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: string): void {
    if (value.length * 2 > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old !== undefined) {
      this.bytes -= old.length * 2;
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.bytes += value.length * 2;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.length * 2;
      this.entries.delete(oldest);
    }
  }
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

let sequence = 0;
const pending = new Map<number, (value: string | undefined) => void>();
export function cacheRequest(
  operation: "get" | "set",
  key: string,
  value?: string,
): Promise<string | undefined> {
  return new Promise((resolve: (value: string | undefined) => void): void => {
    const id = ++sequence;
    pending.set(id, resolve);
    self.postMessage({
      channel: "peerpedia-diagram-cache",
      id,
      operation,
      key,
      value,
    } satisfies CacheRequest);
  });
}
export function receiveCacheResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Partial<CacheResponse>;
  if (response.channel !== "peerpedia-diagram-cache") return false;
  if (
    typeof response.id === "number" &&
    (response.value === undefined || typeof response.value === "string")
  ) {
    pending.get(response.id)?.(response.value);
    pending.delete(response.id);
  }
  return true;
}
