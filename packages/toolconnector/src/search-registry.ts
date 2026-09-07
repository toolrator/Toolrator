import type { SearchEngine } from "./search-engine.js";

export class SearchRegistry {
  private engines: Map<string, SearchEngine> = new Map();

  register(engine: SearchEngine): void {
    this.engines.set(engine.id, engine);
  }

  get(id: string): SearchEngine | undefined {
    return this.engines.get(id);
  }

  getAll(): SearchEngine[] {
    return Array.from(this.engines.values());
  }

  getEngineIds(): string[] {
    return Array.from(this.engines.keys());
  }

  clear(): void {
    this.engines.clear();
  }

  async search(engineId: string, args: Record<string, unknown>): Promise<unknown> {
    const engine = this.engines.get(engineId);
    if (!engine) {
      throw new Error(`Unknown engine: ${engineId}`);
    }
    return engine.search(args);
  }

  async closeAll(): Promise<void> {
    for (const engine of this.engines.values()) {
      await engine.close().catch(() => {});
    }
  }
}
