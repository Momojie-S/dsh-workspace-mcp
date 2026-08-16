/**
 * 项目级 MCP 配置文件解析。
 *
 * 文件格式（YAML，默认路径 <cwd>/.dsh/mcp.servers.yml）:
 *
 *   servers:
 *     my-server:
 *       transport: stdio
 *       command: npx
 *       args: ["-y", "foo-mcp"]
 *       env: {}
 *     remote:
 *       transport: streamable-http
 *       url: https://example.com/mcp
 *       headers:
 *         Authorization: "Bearer xxx"
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

/**
 * 重连策略（与官方 dsh-mcp-client 的 reconnect 字段对齐）。
 * 配置层只管 shape；默认值与边界判定在 mcp.ts 的 resolveReconnectPolicy。
 */
export interface ReconnectPolicy {
  enabled: boolean;
  /** 首次重连延迟（毫秒），此后指数翻倍。 */
  initialDelayMs: number;
  /** 退避封顶（毫秒）；也充当"健康稳定窗口"——连接存活超过它则重置尝试预算。 */
  maxDelayMs: number;
  /** 一次断线周期内最大连续失败尝试次数。 */
  maxAttempts: number;
}

/** 单个 MCP server 的配置（与 dsh-mcp-client Config 字段对齐）。 */
export interface ServerConfig {
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** 单次 callTool 超时（毫秒），默认 60000。 */
  toolCallTimeoutMs?: number;
  /** 重连策略覆盖（逐项覆盖插件级配置，缺省回退插件级/内置默认）。 */
  reconnect?: Partial<ReconnectPolicy>;
}

/** 项目级 MCP 配置文件根。 */
export interface McpConfig {
  servers: Record<string, ServerConfig>;
}

/** serverName 合法字符（与 dsh-mcp-client 一致）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 读取并解析项目级 MCP 配置。
 *
 * @param cwd - session 的工作目录（workspace 根）。
 * @param relativePath - 配置文件相对 cwd 的路径，默认 ".dsh/mcp.servers.yml"。
 * @returns 解析后的配置；文件不存在则返回 null（该 workspace 无项目级 MCP）。
 * @throws 配置文件存在但格式非法时抛错（缺 transport、serverName 非法等）。
 */
export function loadWorkspaceMcpConfig(
  cwd: string,
  relativePath: string = ".dsh/mcp.servers.yml"
): McpConfig | null {
  const filePath = resolve(cwd, relativePath);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw new Error(`workspace-mcp: 读取配置失败 ${filePath}: ${e?.message ?? e}`);
  }

  const parsed = yaml.load(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`workspace-mcp: ${filePath} 顶层必须是 mapping`);
  }

  const serversRaw = (parsed as any).servers;
  if (serversRaw === undefined) return { servers: {} };
  if (typeof serversRaw !== "object" || serversRaw === null) {
    throw new Error(`workspace-mcp: ${filePath} 的 servers 必须是 mapping`);
  }

  const servers: Record<string, ServerConfig> = {};
  for (const [name, cfg] of Object.entries(serversRaw as Record<string, any>)) {
    servers[name] = validateServerConfig(filePath, name, cfg);
  }
  return { servers };
}

/** 校验单个 server 配置。 */
function validateServerConfig(filePath: string, name: string, cfg: any): ServerConfig {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`workspace-mcp: ${filePath} server 名 "${name}" 非法（需匹配 ${SERVER_NAME_PATTERN}）`);
  }
  if (typeof cfg !== "object" || cfg === null) {
    throw new Error(`workspace-mcp: ${filePath} server "${name}" 必须是 mapping`);
  }
  const transport = cfg.transport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw new Error(`workspace-mcp: ${filePath} server "${name}" transport 必须是 "stdio" 或 "streamable-http"`);
  }
  const out: ServerConfig = { transport };
  if (transport === "stdio") {
    if (typeof cfg.command !== "string") {
      throw new Error(`workspace-mcp: ${filePath} server "${name}" (stdio) 缺 command`);
    }
    out.command = cfg.command;
    if (cfg.args !== undefined) {
      if (!Array.isArray(cfg.args) || !cfg.args.every((a: any) => typeof a === "string")) {
        throw new Error(`workspace-mcp: ${filePath} server "${name}" args 必须是字符串数组`);
      }
      out.args = cfg.args;
    }
    if (cfg.env !== undefined) out.env = normalizeStringMap(cfg.env, filePath, name, "env");
    if (cfg.cwd !== undefined && typeof cfg.cwd === "string") out.cwd = cfg.cwd;
  } else {
    if (typeof cfg.url !== "string") {
      throw new Error(`workspace-mcp: ${filePath} server "${name}" (streamable-http) 缺 url`);
    }
    out.url = cfg.url;
    if (cfg.headers !== undefined) out.headers = normalizeStringMap(cfg.headers, filePath, name, "headers");
  }
  if (cfg.toolCallTimeoutMs !== undefined) {
    if (typeof cfg.toolCallTimeoutMs !== "number" || cfg.toolCallTimeoutMs <= 0) {
      throw new Error(`workspace-mcp: ${filePath} server "${name}" toolCallTimeoutMs 必须是正数`);
    }
    out.toolCallTimeoutMs = cfg.toolCallTimeoutMs;
  }
  if (cfg.reconnect !== undefined) {
    out.reconnect = validateReconnect(cfg.reconnect, filePath, name);
  }
  return out;
}

/** 校验 per-server reconnect 覆盖块（shape 级；跨字段边界在 resolveReconnectPolicy 判）。 */
function validateReconnect(
  v: any,
  filePath: string,
  name: string
): Partial<ReconnectPolicy> {
  if (typeof v !== "object" || v === null) {
    throw new Error(`workspace-mcp: ${filePath} server "${name}" reconnect 必须是 mapping`);
  }
  for (const key of Object.keys(v)) {
    if (!["enabled", "initialDelayMs", "maxDelayMs", "maxAttempts"].includes(key)) {
      throw new Error(`workspace-mcp: ${filePath} server "${name}" reconnect.${key} 不是合法字段`);
    }
  }
  const out: Partial<ReconnectPolicy> = {};
  if (v.enabled !== undefined) {
    if (typeof v.enabled !== "boolean") {
      throw new Error(`workspace-mcp: ${filePath} server "${name}" reconnect.enabled 必须是 boolean`);
    }
    out.enabled = v.enabled;
  }
  for (const key of ["initialDelayMs", "maxDelayMs"] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== "number" || !Number.isFinite(v[key]) || v[key] <= 0) {
        throw new Error(`workspace-mcp: ${filePath} server "${name}" reconnect.${key} 必须是正数`);
      }
      out[key] = v[key];
    }
  }
  if (v.maxAttempts !== undefined) {
    if (typeof v.maxAttempts !== "number" || !Number.isInteger(v.maxAttempts) || v.maxAttempts < 1) {
      throw new Error(`workspace-mcp: ${filePath} server "${name}" reconnect.maxAttempts 必须是正整数`);
    }
    out.maxAttempts = v.maxAttempts;
  }
  return out;
}

function normalizeStringMap(
  v: any,
  filePath: string,
  name: string,
  field: string
): Record<string, string> {
  if (typeof v !== "object" || v === null) {
    throw new Error(`workspace-mcp: ${filePath} server "${name}" ${field} 必须是 string→string mapping`);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = typeof val === "string" ? val : String(val);
  }
  return out;
}

/** 用 js-yaml 解析（DSH 运行时已包含，app-boot 也用它）。 */