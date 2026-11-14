/**
 * instructions 测试用的 stdio MCP server：握手声明 server instructions
 * （经 ServerOptions.instructions，InitializeResult 原样带回客户端）。
 *
 * 工具:
 *   - pid → 回自身进程 pid（复用既有测试的存活探针习惯）
 *
 * instructions 文本经 --mode 参数控制:
 *   - 短文本（默认）: 两行全局口径
 *   - long: 超长文本（供 maxInstructionBytes 超限用例按字节上限截断判断）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2] === "long" ? "long" : "short";
const instructions =
  mode === "long"
    ? `FILLER${"x".repeat(50_000)}`
    : "全局口径：截图统一 1920*1080；矩形用 (x1, y1, x2, y2)。";

const server = new Server(
  { name: "instructions-smoke", version: "0.0.1" },
  { capabilities: { tools: {} }, instructions }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "pid",
      description: "return own process id",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: String(process.pid) }],
}));

await server.connect(new StdioServerTransport());
