/**
 * MCP server 连接 + 工具发现 + agent-scoped 注册。
 * 复用 @modelcontextprotocol/sdk，命名 mcp__<server>__<tool>（与 dsh-mcp-client 一致）。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServerConfig } from "./config.js";

const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

/**
 * 宽松结果校验 schema：信任 MCP server 返回的 JSON，只做 record(shape) 校验，
 * 不让 SDK 用 CallToolResultSchema 预校验（否则遇到结构化/兼容结果会失败）。
 * 与官方 dsh-mcp-client 的 RawCallToolResultSchema 一致。
 */
const RawCallToolResultSchema = z.record(z.string(), z.unknown());

/**
 * 从 MCP content 数组中提取文本，与官方 dsh-mcp-client 的 extractText 一致。
 * text blocks 拼接为字符串；image/audio/resource 替换为占位符。
 */
function extractText(mcpContent: any[], toolName: string): string {
  const parts: string[] = [];
  for (const value of mcpContent) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      parts.push("[unsupported content type: unknown]");
      continue;
    }
    const block = value as Record<string, any>;
    switch (block.type) {
      case "text":
        if (block.text !== undefined) parts.push(String(block.text));
        break;
      case "image":
        parts.push(`[image: ${block.mimeType ?? "unknown"}, content discarded]`);
        break;
      case "audio":
        parts.push(`[audio: ${block.mimeType ?? "unknown"}, content discarded]`);
        break;
      case "resource":
      case "resource_link":
        parts.push("[resource: content discarded]");
        break;
      default:
        parts.push(`[unsupported content type: ${block.type ?? "unknown"}]`);
    }
  }
  return parts.join("\n") || `(${toolName} returned no text content)`;
}

/** 一个 server 的连接句柄：用于 agent 销毁时清理。 */
export interface ServerHandle {
  serverName: string;
  client: Client;
  /** 已注册的工具 disposer 列表（agent-scoped register 返回的）。 */
  disposers: Array<() => void>;
}

/** 关闭一个 server 连接：断开 MCP + 卸载工具。 */
export function disposeServer(handle: ServerHandle): void {
  for (const d of handle.disposers) {
    try { d(); } catch { /* 忽略 */ }
  }
  handle.disposers = [];
  try { handle.client.close(); } catch { /* 忽略 */ }
}

export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash("sha256")
    .update(`${serverName}\0${rawName}`)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

function createTransport(cfg: ServerConfig) {
  if (cfg.transport === "stdio") {
    return new StdioClientTransport({
      command: cfg.command!,
      args: cfg.args ?? [],
      env: cfg.env as Record<string, string> | undefined,
      cwd: cfg.cwd,
    });
  }
  return new StreamableHTTPClientTransport(new URL(cfg.url!), {
    requestInit: cfg.headers ? { headers: cfg.headers } : {},
  });
}

/**
 * 连接一个 MCP server，发现工具，注册到 agent 的 scoped tools 服务。
 *
 * 注意: agent.ctx 在 agent/created 时可能是 inactive，不能用 agentCtx.effect，
 * 所以本函数返回 ServerHandle，由调用方在 agent/disposed 时 disposeServer。
 *
 * @returns 连接句柄；失败时返回 null。
 */
export async function connectAndRegister(
  agentCtx: any,
  serverName: string,
  cfg: ServerConfig,
  log: (msg: string) => void
): Promise<ServerHandle | null> {
  const client = new Client(
    { name: "dsh-workspace-mcp", version: "0.1.0" },
    { capabilities: {} }
  );
  const transport = createTransport(cfg);

  try {
    await client.connect(transport);
  } catch (e: any) {
    log(`server "${serverName}" 连接失败: ${e?.message ?? e}（跳过）`);
    return null;
  }

  const tools: any[] = [];
  let cursor: string | undefined;
  try {
    do {
      const resp = await client.request(
        { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
        ListToolsResultSchema
      );
      tools.push(...resp.tools);
      cursor = resp.nextCursor;
    } while (cursor);
  } catch (e: any) {
    log(`server "${serverName}" tools/list 失败: ${e?.message ?? e}（跳过）`);
    try { client.close(); } catch { /* */ }
    return null;
  }

  const disposers: Array<() => void> = [];
  const timeoutMs = cfg.toolCallTimeoutMs ?? 60000;
  for (const tool of tools) {
    const publicName = publicToolName(serverName, tool.name);
    const rawName = tool.name;
    try {
      const d = agentCtx.tools.register({
        name: publicName,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
        output: {
          schema: {
            type: "object",
            properties: { content: { type: "array", items: {} } },
          },
          render(_args: any, value: any): any[] {
            // render 必须返回 ContentBlocks 数组，不能返回纯字符串。
            // DSH 的 contentHasImage 会递归对 tool-result 的 content 调用 .some()，
            // 如果返回字符串会导致 "content.some is not a function" 错误，
            // 且该错误会持久化到 session 日志中，导致后续每轮对话都失败。
            const content = Array.isArray(value?.content) ? value.content : [];
            return [{ type: "text", text: extractText(content, rawName) }];
          },
        },
        async execute(args: any, exec: any) {
          const argObj = typeof args === "object" && args !== null ? args : {};
          const result = await client.request(
            { method: "tools/call", params: { name: rawName, arguments: argObj } },
            RawCallToolResultSchema,
            { signal: exec?.signal, timeout: timeoutMs }
          );
          // MCP 返回的 content 可能不是数组（某些 server 返回 toolResult / 其他结构），
          // 与官方 dsh-mcp-client 一致：归一化为标准 content 数组。
          if (!Array.isArray(result?.content)) {
            const rendered =
              result && "toolResult" in result ? JSON.stringify((result as any).toolResult) : "(no output)";
            const text = typeof rendered === "string" ? rendered : "(no output)";
            if (result?.isError === true) {
              throw new Error(text);
            }
            return {
              content: [{ type: "text", text }],
              ...result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {},
            };
          }
          // 标准 content 数组路径
          const content = result.content;
          if (result?.isError === true) {
            throw new Error(extractText(content, rawName));
          }
          return {
            content,
            ...result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {},
          };
        },
      });
      disposers.push(d);
    } catch (e: any) {
      log(`server "${serverName}" 工具 "${rawName}" 注册失败: ${e?.message ?? e}`);
    }
  }

  log(`server "${serverName}": 注册 ${disposers.length} 个工具`);
  return { serverName, client, disposers };
}