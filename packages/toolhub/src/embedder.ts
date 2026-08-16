// ---------------------------------------------------------------------------
// toolhub — Local ONNX Embedder
// ---------------------------------------------------------------------------
// Uses Transformers.js (@xenova/transformers) to run multilingual-e5-small
// locally under ONNX Runtime. This computes 384-dimensional dense vectors
// for semantic hybrid search.
// ---------------------------------------------------------------------------

export class Embedder {
  private pipelinePromise: any = null;

  constructor(
    private readonly logger: Pick<Console, "info" | "warn" | "error"> = console,
  ) {}

  private async getPipeline() {
    if (!this.pipelinePromise) {
      this.logger.info("[embedder] Loading Xenova/multilingual-e5-small ONNX model...");
      const t0 = performance.now();
      this.pipelinePromise = (async () => {
        // Dynamic import to avoid loading transformers during boot before config check
        const { pipeline, env } = await import("@xenova/transformers");
        
        // Disable telemetry/analytics and use standard defaults
        env.allowLocalModels = false; // Always fetch from HuggingFace Hub on first run
        
        return pipeline("feature-extraction", "Xenova/multilingual-e5-small");
      })();
      
      this.pipelinePromise.then(
        () => {
          const duration = performance.now() - t0;
          this.logger.info(`[embedder] Model loaded successfully in ${duration.toFixed(0)}ms`);
        },
        (err: any) => {
          this.logger.error("[embedder] Failed to load model:", err);
          this.pipelinePromise = null; // Reset on failure so we can retry
        }
      );
    }
    return this.pipelinePromise;
  }

  /**
   * Generates a 384-dimensional embedding for document indexing.
   * Automatically prefixes the text with "passage: " as required by E5 models.
   */
  async embedDocument(text: string): Promise<number[]> {
    const extractor = await this.getPipeline();
    const formattedText = `passage: ${text}`;
    
    const output = await extractor(formattedText, {
      pooling: "mean",
      normalize: true,
    });
    
    return Array.from(output.data) as number[];
  }

  /**
   * Generates a 384-dimensional embedding for search queries.
   * Automatically prefixes the text with "query: " as required by E5 models.
   */
  async embedQuery(text: string): Promise<number[]> {
    const extractor = await this.getPipeline();
    const formattedText = `query: ${text}`;
    
    const output = await extractor(formattedText, {
      pooling: "mean",
      normalize: true,
    });
    
    return Array.from(output.data) as number[];
  }
}
