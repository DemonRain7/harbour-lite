import type { PostToolUseFailureHookSpecificOutput } from "@anthropic-ai/claude-agent-sdk";

/** Decode only complete JSON and recognized MCP text envelopes for audit metadata.
 * This never changes tool arguments, repairs partial JSON, or executes/retries a tool.
 */
export function decodeSdkToolResult(input: unknown): { value: unknown; isError: boolean } {
  let value = input;
  let isError = false;
  // Bound recursive/stringified envelopes, including accidental cyclic objects.
  for (let depth = 0; depth < 12; depth++) {
    if (isRecord(value)) {
      isError ||= value.isError === true;
      // A structured business error is already a receipt, not a text envelope.
      if (typeof value.error === "string" && value.error.trim().length > 0) break;
      if (Array.isArray(value.content) && value.content.length > 0) {
        value = value.content;
        continue;
      }
    }
    if (Array.isArray(value) && value.length > 0
      && value.every((block) => isRecord(block) && typeof block.type === "string"
        && ["text", "image", "audio", "resource", "resource_link"].includes(block.type))) {
      const text = value.filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string).join("\n");
      if (text) {
        value = text;
        continue;
      }
    }
    if (typeof value === "string" && value.length <= 64_000) {
      const notice = value.indexOf("\n\n[HARBOUR_BUDGET]\n");
      const payload = notice < 0 ? value : value.slice(0, notice);
      try {
        value = JSON.parse(payload) as unknown;
        continue;
      } catch { /* ordinary text or incomplete JSON: never repair it */ }
    }
    break;
  }
  return { value, isError };
}

export interface SdkToolFailure {
  failureStage: "argument_decode" | "input_schema" | "tool_execution";
  errorCode: "SDK_TOOL_ARGUMENT_JSON_INVALID" | "SDK_TOOL_INPUT_SCHEMA_INVALID" | "HARBOUR_TOOL_RETURNED_ERROR";
  reasonCode?: "input_validation";
  /** Only an explicit SDK pre-execution rejection proves the tool did not run. */
  executed?: false;
}

/** Match SDK-owned error prefixes, not arbitrary prose mentioning JSON/schema.
 * Only explicit error results may establish an SDK validation failure. Tool name
 * matching prevents a quoted error for a different call from being attributed here.
 */
export function classifySdkToolFailure(
  value: unknown,
  toolName: string,
  reportedError: boolean,
): SdkToolFailure | undefined {
  const text = typeof value === "string" ? value
    : isRecord(value) && typeof value.error === "string" ? value.error : undefined;
  if (reportedError && text) {
    const prefix = text.slice(0, 1_024);
    const decode = /^<tool_use_error>InputValidationError: ([\w.-]+) was called with input that could not be parsed as JSON\./.exec(prefix);
    if (decode?.[1] === toolName) {
      return { failureStage: "argument_decode", errorCode: "SDK_TOOL_ARGUMENT_JSON_INVALID", reasonCode: "input_validation", executed: false };
    }
    // The SDK MCP server emits this precise InvalidParams error before its handler.
    const schema = /^(?:<tool_use_error>)?(?:Error: )?(?:MCP error -32602: )?Input validation error: Invalid arguments for tool ([\w.-]+):/.exec(prefix);
    if (schema && (schema[1] === toolName || schema[1] === toolName.replace(/^mcp__harbour_tools__/, ""))) {
      return { failureStage: "input_schema", errorCode: "SDK_TOOL_INPUT_SCHEMA_INVALID", reasonCode: "input_validation", executed: false };
    }
  }
  // Harbour catches execution errors as {error: string}; SDK sometimes labels the
  // surrounding MCP result successful. Do not infer JSON/schema failure or no side
  // effects from a business guard, refused result, or an ordinary thrown error.
  if (toolName.startsWith("mcp__harbour_tools__") && isRecord(value)
    && typeof value.error === "string" && value.error.trim().length > 0) {
    return { failureStage: "tool_execution", errorCode: "HARBOUR_TOOL_RETURNED_ERROR" };
  }
  return undefined;
}

/** The installed SDK supports additionalContext on PostToolUseFailure. This is
 * on-demand model feedback, never an argument transformation or an execution.
 * Some SDK input rejections only appear in tool_result; without this hook there
 * is deliberately no injection, query restart, or attempt to replay the call.
 */
export function sdkToolInputCorrection(
  error: unknown,
  toolName: string,
  interrupted = false,
): PostToolUseFailureHookSpecificOutput | undefined {
  if (interrupted) return;
  const failure = classifySdkToolFailure(error, toolName, true);
  if (failure?.executed !== false
    || (failure.failureStage !== "argument_decode" && failure.failureStage !== "input_schema")) return;
  const workflowHint = toolName === "mcp__harbour_tools__run_workflow"
    ? " For a large workflow input, read_workflow(resource=\"input-staging\") explains prepare_input chunks and final inputRef submission. Keep the last successfully prepared reference; correct only the rejected chunk. Preparation is not workflow execution."
    : "";
  return {
    hookEventName: "PostToolUseFailure",
    additionalContext: `[Harbour tool input correction: ${failure.failureStage}] The SDK rejected this call before execution. Re-check the tool's declared schema. If continuing this call, send a real JSON object with complete, correctly escaped strings, not Markdown fences or a double-encoded JSON string. Preserve the user's intended meaning; do not guess missing fields or broaden the task. Correct only this rejected call. Do not repeat completed writes, replay earlier tools, or restart the whole task.${workflowHint}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
