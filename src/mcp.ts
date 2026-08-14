/**
 * MCP server 连接 + 工具发现 + agent-scoped 注册。
 * 复用 @modelcontextprotocol/sdk，命名 mcp__<server>__<tool>（与 dsh-mcp-client 一致）。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import type { ServerConfig } from "./config.js";

const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

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
          render(result: any): string {
            return renderToolResult(result);
          },
        },
        async execute(args: any, exec: any) {
          return await client.request(
            { method: "tools/call", params: { name: rawName, arguments: args } },
            { parse: (x: any) => x, jsonSchema: undefined } as any,
            { signal: exec?.signal, timeout: timeoutMs }
          );
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

function renderToolResult(result: any): string {
  if (!result || !Array.isArray(result.content)) return "(空结果)";
  const parts: string[] = [];
  for (const block of result.content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block && typeof block === "object") {
      parts.push(`[${block.type ?? "block"}]`);
    }
  }
  return parts.join("\n");
}