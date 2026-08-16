import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./config.js";
import { resolveTarget, isHttpUrl, isValidMcpName } from "./target-resolver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FavoriteEntry {
  mcpNameOrUrl: string;
  notes?: string;
  savedAt: string;
}

export interface FavoriteListItem {
  mcpNameOrUrl: string;
  notes?: string;
  savedAt: string;
  isRegistered: boolean;
  displayName?: string;
  description?: string;
  tags?: string[];
  docsUrl?: string;
  homepageUrl?: string;
  provider?: string;
}

// ---------------------------------------------------------------------------
// Constants & Regex
// ---------------------------------------------------------------------------

const FAVORITES_FILENAME = "favorites.json";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates the identifier.
 * Returns the normalized identifier if valid, otherwise throws an error.
 */
export function validateMcpIdentifier(value: string): string {
  try {
    const resolved = resolveTarget(value);
    return resolved.url;
  } catch (err: any) {
    throw new Error(
      `Invalid MCP identifier: "${value}". Must be a valid HTTP/HTTPS URL (e.g., "http://localhost:8080/mcp"). ` +
      `Registry names are no longer supported. Details: ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Core Operations
// ---------------------------------------------------------------------------

export async function loadFavorites(configDir: string, logger: Logger): Promise<FavoriteEntry[]> {
  const filePath = join(configDir, FAVORITES_FILENAME);
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn(`Favorites file at ${filePath} is not a valid JSON array. Returning empty.`);
      return [];
    }
    
    return parsed.map((item: any) => ({
      mcpNameOrUrl: String(item.mcpNameOrUrl || ""),
      notes: item.notes !== undefined ? String(item.notes) : undefined,
      savedAt: String(item.savedAt || new Date().toISOString()),
    })).filter(item => item.mcpNameOrUrl !== "");
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      logger.warn(`Failed to read favorites file at ${filePath}: ${String(err)}`);
    }
    return [];
  }
}

export async function saveFavorites(
  configDir: string,
  favorites: FavoriteEntry[],
  logger: Logger
): Promise<void> {
  const filePath = join(configDir, FAVORITES_FILENAME);
  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(filePath, JSON.stringify(favorites, null, 2), "utf-8");
    logger.debug(`Saved ${favorites.length} favorites to ${filePath}`);
  } catch (err) {
    logger.error(`Failed to save favorites to ${filePath}: ${String(err)}`);
    throw new Error(`Failed to persist favorites: ${String(err)}`);
  }
}

export async function addFavorite(
  configDir: string,
  mcpNameOrUrl: string,
  notes: string | undefined,
  logger: Logger
): Promise<void> {
  const validated = validateMcpIdentifier(mcpNameOrUrl);
  const favorites = await loadFavorites(configDir, logger);
  
  const existingIndex = favorites.findIndex(
    f => f.mcpNameOrUrl.toLowerCase() === validated.toLowerCase()
  );
  
  const now = new Date().toISOString();
  
  if (existingIndex >= 0) {
    favorites[existingIndex] = {
      mcpNameOrUrl: validated,
      notes: notes !== undefined ? notes : favorites[existingIndex].notes,
      savedAt: favorites[existingIndex].savedAt, // preserve original save time
    };
    logger.info(`Updated existing favorite: ${validated}`);
  } else {
    favorites.push({
      mcpNameOrUrl: validated,
      notes,
      savedAt: now,
    });
    logger.info(`Added new favorite: ${validated}`);
  }
  
  await saveFavorites(configDir, favorites, logger);
}

export async function removeFavorite(
  configDir: string,
  mcpNameOrUrl: string,
  logger: Logger
): Promise<boolean> {
  const validated = validateMcpIdentifier(mcpNameOrUrl);
  const favorites = await loadFavorites(configDir, logger);
  
  const filtered = favorites.filter(
    f => f.mcpNameOrUrl.toLowerCase() !== validated.toLowerCase()
  );
  
  const removed = favorites.length !== filtered.length;
  if (removed) {
    logger.info(`Removed favorite: ${validated}`);
    await saveFavorites(configDir, filtered, logger);
  } else {
    logger.debug(`Favorite not found for removal: ${validated}`);
  }
  
  return removed;
}

export async function getNoteForServer(
  configDir: string,
  target: string,
  logger: Logger
): Promise<string | undefined> {
  try {
    const normalized = validateMcpIdentifier(target);
    const favorites = await loadFavorites(configDir, logger);
    const entry = favorites.find(
      f => f.mcpNameOrUrl.toLowerCase() === normalized.toLowerCase()
    );
    return entry?.notes;
  } catch {
    return undefined;
  }
}

export async function listFavoritesWithDetails(
  configDir: string,
  logger: Logger
): Promise<FavoriteListItem[]> {
  const favorites = await loadFavorites(configDir, logger);
  if (favorites.length === 0) {
    return [];
  }

  return favorites.map((fav): FavoriteListItem => {
    const isRegistered = !isHttpUrl(fav.mcpNameOrUrl) && isValidMcpName(fav.mcpNameOrUrl);
    const item: FavoriteListItem = {
      mcpNameOrUrl: fav.mcpNameOrUrl,
      notes: fav.notes,
      savedAt: fav.savedAt,
      isRegistered,
    };

    if (isRegistered) {
      item.description = "Registered MCP server. Server details currently unavailable.";
    }

    return item;
  });
}
