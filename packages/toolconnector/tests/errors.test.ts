/**
 * Unit tests for classifyUpstreamError — locks the documented error-code
 * contract (AGENTS.md error-classification table) so renumbering or
 * re-wording a branch fails CI before it breaks agents in the wild.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyUpstreamError } from "../src/errors.js";

describe("classifyUpstreamError: auth_required", () => {
  test("401 status → auth_required with OAuth required_step", () => {
    const err = classifyUpstreamError(401, "");
    assert.equal(err.error_code, "auth_required");
    assert.equal(err.reason, "upstream_auth");
    assert.match(err.required_step ?? "", /start_oauth/);
  });

  test("JSON-RPC auth error code -32001 → auth_required", () => {
    const body = JSON.stringify({ error: { code: -32001, message: "nope" } });
    assert.equal(classifyUpstreamError(500, body).error_code, "auth_required");
  });

  test("message containing 'unauthorized' → auth_required", () => {
    assert.equal(classifyUpstreamError(400, "User is unauthorized").error_code, "auth_required");
  });
});

describe("classifyUpstreamError: 404 split", () => {
  test("404 mentioning tool → tool_not_found", () => {
    const err = classifyUpstreamError(404, "tool not found here");
    assert.equal(err.error_code, "tool_not_found");
  });

  test("404 without tool mention → server_not_found", () => {
    const err = classifyUpstreamError(404, "no such route");
    assert.equal(err.error_code, "server_not_found");
  });
});

describe("classifyUpstreamError: JSON-RPC code mapping", () => {
  test("-32601 → tool_not_found", () => {
    const body = JSON.stringify({ error: { code: -32601, message: "method not found" } });
    assert.equal(classifyUpstreamError(500, body).error_code, "tool_not_found");
  });

  test("-32602 → resource_not_found", () => {
    const body = JSON.stringify({ error: { code: -32602, message: "invalid params" } });
    const err = classifyUpstreamError(500, body);
    assert.equal(err.error_code, "resource_not_found");
  });

  test("-32022 → unsupported_protocol_version", () => {
    const body = JSON.stringify({ error: { code: -32022, message: "bad version" } });
    assert.equal(classifyUpstreamError(500, body).error_code, "unsupported_protocol_version");
  });

  test("-32020 → header_mismatch", () => {
    const body = JSON.stringify({ error: { code: -32020, message: "headers differ" } });
    assert.equal(classifyUpstreamError(500, body).error_code, "header_mismatch");
  });
});

describe("classifyUpstreamError: message-word fallbacks", () => {
  test("'UnsupportedProtocolVersion' in text → unsupported_protocol_version", () => {
    assert.equal(
      classifyUpstreamError(400, "server returned UnsupportedProtocolVersion").error_code,
      "unsupported_protocol_version",
    );
  });

  test("'header mismatch' in text → header_mismatch", () => {
    assert.equal(
      classifyUpstreamError(400, "Header mismatch between payload and headers").error_code,
      "header_mismatch",
    );
  });

  test("'resource not found' prose → resource_not_found", () => {
    assert.equal(
      classifyUpstreamError(400, "the resource not found in this server").error_code,
      "resource_not_found",
    );
  });
});

describe("classifyUpstreamError: catch-all + context", () => {
  test("unrecognized 500 → execution_failed carrying the upstream reason", () => {
    const err = classifyUpstreamError(500, "upstream exploded");
    assert.equal(err.error_code, "execution_failed");
    assert.equal(err.reason, "upstream exploded");
  });

  test("non-JSON body without message → execution_failed with fallback reason", () => {
    const err = classifyUpstreamError(502, "");
    assert.equal(err.error_code, "execution_failed");
    assert.ok(err.reason);
  });

  test("context.memory_note is threaded through every branch", () => {
    const a = classifyUpstreamError(401, "", { memory_note: "note-1" });
    assert.equal(a.memory_note, "note-1");
    const b = classifyUpstreamError(500, "x", { memory_note: "note-2" });
    assert.equal(b.memory_note, "note-2");
  });

  test("context.code is used when the body has no JSON-RPC code", () => {
    const err = classifyUpstreamError(400, "plain text", { code: -32022 });
    assert.equal(err.error_code, "unsupported_protocol_version");
  });
});
