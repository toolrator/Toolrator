import { Hono } from "hono";

/**
 * Well-known endpoints (RFD 8615 style). These are stable URLs that external
 * tooling — such as the toolconnector's liveness probe — can hit without prior
 * configuration. The paths are intentionally hardcoded here as a contract.
 *
 * `/.well-known/toolpanel-alive` returns 204 No Content when this toolpanel
 * instance is healthy and accepting requests. Any 2xx response is treated by
 * the connector as "alive". Any other status (including 404) means "not here".
 *
 * Registered for GET only. HEAD is not commonly used by probes and Hono's
 * sub-router does not chain `.head()` in this version; GET is sufficient.
 *
 * No authentication, no body, no side effects. Safe to probe frequently.
 */
export const wellKnown = new Hono();

wellKnown.get("/.well-known/toolpanel-alive", (c) =>
  c.body(null, 204, { "Cache-Control": "no-store" }),
);
