// ---------------------------------------------------------------------------
// toolhub — Embedding fingerprint
// ---------------------------------------------------------------------------
// A fingerprint uniquely describes how the search indexes were built
// (embedding provider/model, dims, budgets, pooling, builder versions).
//
// `current` = what the running config wants; `active` = what the indexes
// were actually built with. When they differ, a full reindex is required —
// the enterprise orchestrator reads this from /health and triggers it
// (TOOLHUB_AUTO_REINDEX_ENABLED, see plan D5).
// ---------------------------------------------------------------------------

import type { SearchEngineConfig } from "./config.js";
import { embeddingProfile } from "./embedder.js";

export const FINGERPRINT_VERSION = 2;

/** Compact schema renderer version (changes invalidate tool vectors). */
const COMPACT_SCHEMA_VERSION = 1;

/** Indexer semantic-text builder version (changes invalidate vectors). */
const INDEXER_BUILDER_VERSION = 2;

/**
 * Computes the fingerprint string for the current configuration.
 * Any change here means previously stored vectors are no longer
 * representative — bump FINGERPRINT_VERSION when the inputs change.
 */
export function computeEmbeddingFingerprint(config: SearchEngineConfig): string {
  const p = embeddingProfile();
  return [
    `v${FINGERPRINT_VERSION}`,
    p.provider,
    p.model,
    String(p.dimensions),
    String(p.maxInputChars),
    String(p.charsPerToken),
    String(p.minChunkChars),
    p.poolingMode,
    `indexer-${INDEXER_BUILDER_VERSION}`,
    `compact-schema-${COMPACT_SCHEMA_VERSION}`,
    config.toolIndexEnabled ? config.toolIndexName : "none",
  ].join("|");
}
