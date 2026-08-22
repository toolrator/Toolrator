// ---------------------------------------------------------------------------
// toolhub — Compact JSON Schema generator
// ---------------------------------------------------------------------------
// Turns a raw JSON Schema (as exposed by an MCP tool's inputSchema) into a
// short, embeddable text form: property names, types, required markers,
// enums and array item types, depth-limited, without $schema/definitions/
// examples/defaults. Used for tool-level semantic vectors so schema-heavy
// tools are searchable without bloating the embedding input.
// ---------------------------------------------------------------------------

const MAX_DEPTH = 3;

/**
 * Generates a compact schema string like:
 *   input: { owner: string(required), repo: string(required), labels: string[] }
 * Safe for embedding; never throws (malformed input yields a short marker).
 */
export function generateCompactSchema(
  inputSchema: unknown,
  maxChars = 1200,
): string {
  if (!inputSchema || typeof inputSchema !== "object") {
    return "";
  }

  const schema = inputSchema as Record<string, unknown>;

  // Composition keywords — render as compact unions
  if (schema.oneOf || schema.anyOf || schema.allOf) {
    const variants = (schema.oneOf ?? schema.anyOf ?? schema.allOf) as unknown[];
    if (Array.isArray(variants) && variants.length > 0) {
      const parts = variants
        .map((v) => describeValue(v, 1))
        .filter(Boolean)
        .slice(0, 6);
      if (parts.length > 0) {
        const out = `input: union[${parts.join(" | ")}]`;
        return truncateSafe(out, maxChars);
      }
    }
  }

  if (schema.$ref) {
    return `input: ref:${String(schema.$ref)}`;
  }

  const properties = schema.properties;
  if (!properties || typeof properties !== "object") {
    if (schema.type === "object" || schema.additionalProperties) {
      return "input: freeform object";
    }
    return "";
  }

  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const parts: string[] = [];

  for (const [key, prop] of Object.entries(properties)) {
    const desc = describeValue(prop, 1);
    if (!desc) continue;
    const req = required.includes(key) ? "(required)" : "";
    parts.push(`${key}: ${desc}${req}`);
  }

  if (parts.length === 0) return "input: empty object";
  const joined = parts.join(", ");
  const out = `input: { ${joined} }`;
  return truncateSafe(out, maxChars);
}

function describeValue(value: unknown, depth: number): string | null {
  if (value === null || typeof value !== "object") return null;
  const prop = value as Record<string, unknown>;

  const type = typeof prop.type === "string" ? prop.type : undefined;
  const format = typeof prop.format === "string" ? `:${prop.format}` : "";

  // Enums are high-signal for embeddings
  if (Array.isArray(prop.enum)) {
    const values = prop.enum.slice(0, 6).map((v) => String(v)).join("|");
    const hasMore = prop.enum.length > 6 ? "..." : "";
    return `enum[${values}${hasMore}]`;
  }

  if (type === "array") {
    const items = prop.items;
    const itemType =
      items && typeof items === "object"
        ? (typeof (items as Record<string, unknown>).type === "string"
            ? ((items as Record<string, unknown>).type as string)
            : "any")
        : "any";
    return `array<${itemType}>`;
  }

  if (type === "object" && depth < MAX_DEPTH) {
    const nested = prop.properties;
    if (nested && typeof nested === "object") {
      const req = Array.isArray(prop.required) ? (prop.required as string[]) : [];
      const inner: string[] = [];
      for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
        const d = describeValue(v, depth + 1);
        if (d) inner.push(`${k}: ${d}${req.includes(k) ? "(required)" : ""}`);
      }
      return inner.length > 0 ? `object<${inner.join(", ")}>` : "object";
    }
    return "object";
  }

  // oneOf/anyOf inside a property
  if (prop.oneOf || prop.anyOf) {
    const variants = (prop.oneOf ?? prop.anyOf) as unknown[];
    if (Array.isArray(variants)) {
      const parts = variants
        .map((v) => describeValue(v, depth + 1))
        .filter(Boolean)
        .slice(0, 4);
      if (parts.length > 0) return `union[${parts.join(" | ")}]`;
    }
  }

  if (type) return `${type}${format}`;
  if (prop.properties) return "object";
  return "any";
}

function truncateSafe(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  // Cut on a code-point boundary
  const codePoints = Array.from(value);
  return codePoints.slice(0, Math.max(0, max - 1)).join("") + "…";
}