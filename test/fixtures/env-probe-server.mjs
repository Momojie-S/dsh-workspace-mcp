/**
 * parity 测试用的 stdio MCP server：环境变量探针。
 *
 * 工具:
 *   - getenv {name}  → 返回子进程 process.env[name]，不存在回 "(unset)"
 *
 * 用于验证 scrubbed 父环境继承（ADR-0006）：
 * 父继承变量可见 / DSH_* 被剥离 / 凭据形状名被剥离但显式 env 覆盖可传。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "env-probe", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "getenv",
      description: "read one env var from the server process",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.arguments?.name ?? "";
  const value = process.env[name];
  return { content: [{ type: "text", text: value === undefined ? "(unset)" : value }] };
});

await server.connect(new StdioServerTransport());
