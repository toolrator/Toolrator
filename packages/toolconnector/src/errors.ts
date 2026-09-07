export interface StructuredError {
  error_code: string;
  reason?: string;
  required_step?: string;
  memory_note?: string;
}

export function createStructuredError(
  code: string,
  opts?: Partial<StructuredError>
): StructuredError {
  return {
    error_code: code,
    ...opts,
  };
}

export function formatErrorResponse(error: StructuredError): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(error, null, 2),
      },
    ],
    isError: true,
  };
}

export function classifyUpstreamError(
  statusCode: number,
  body: string,
  context?: { target?: string; memory_note?: string; code?: number }
): StructuredError {
  let parsedBody: any = null;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    // not JSON
  }

  const rawMessage = parsedBody?.error?.message || parsedBody?.error || body || "";
  const message = rawMessage.toLowerCase();
  const code = parsedBody?.error?.code ?? context?.code;

  if (
    statusCode === 401 ||
    code === -32001 ||
    message.includes("auth") ||
    message.includes("unauthorized")
  ) {
    return createStructuredError("auth_required", {
      reason: "upstream_auth",
      required_step: "Call manage_auth with action: 'start_device_flow'",
      memory_note: context?.memory_note,
    });
  }

  if (statusCode === 404) {
    if (message.includes("tool")) {
      return createStructuredError("tool_not_found", {
        reason: "tool_not_found",
        required_step: "Call mcp_server with method: 'tools/list' to list available tools",
        memory_note: context?.memory_note,
      });
    }
    return createStructuredError("server_not_found", {
      reason: "server_not_found",
      required_step: "Search for a registered server using search_mcp_ecosystem",
      memory_note: context?.memory_note,
    });
  }

  if (code === -32601 || message.includes("tool_not_found")) {
    return createStructuredError("tool_not_found", {
      reason: "tool_not_found",
      required_step: "Call mcp_server with method: 'tools/list' to list available tools",
      memory_note: context?.memory_note,
    });
  }

  if (code === -32602 || message.includes("resource_not_found") || message.includes("resource not found") || message.includes("Invalid params")) {
    return createStructuredError("resource_not_found", {
      reason: "resource_not_found",
      required_step: "Call mcp_server with method: 'resources/list' to list available resources",
      memory_note: context?.memory_note,
    });
  }

  if (code === -32022 || message.includes("unsupported protocol version") || message.includes("UnsupportedProtocolVersion")) {
    return createStructuredError("unsupported_protocol_version", {
      reason: "unsupported_protocol_version",
      required_step: "The MCP server uses an unsupported protocol version. Please upgrade toolconnector or contact support.",
      memory_note: context?.memory_note,
    });
  }

  if (code === -32020 || message.includes("header mismatch") || message.includes("HeaderMismatch")) {
    return createStructuredError("header_mismatch", {
      reason: "header_mismatch",
      required_step: "The HTTP headers did not match the request payload.",
      memory_note: context?.memory_note,
    });
  }

  return createStructuredError("execution_failed", {
    reason: rawMessage || "upstream error",
    memory_note: context?.memory_note,
  });
}
