/**
 * Smoke 测试用的 stdio MCP server。
 *
 * 工具:
 *   - echo {text}  → 回显 "echo: <text>"
 *   - die          → 回复后 50ms 退出进程（模拟 server 崩溃/被杀）
 *   - addtool      → 动态注册 extra-<n> 工具并发 toolListChanged 通知
 *     （模拟 server 热改工具列表）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const baseTools = [
  {
    name: "echo",
    description: "echo text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "die",
    description: "exit the server process after replying",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "addtool",
    description: "register one more tool and notify list changed",
    inputSchema: { type: "object", properties: {} },
  },
];

let extraCount = 0;
const extraTools = [];

const server = new Server({ name: "echo-smoke", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...baseTools, ...extraTools],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (name === "die") {
    setTimeout(() => process.exit(0), 50);
    return { content: [{ type: "text", text: "dying" }] };
  }
  if (name === "addtool") {
    extraCount += 1;
    const toolName = `extra-${extraCount}`;
    extraTools.push({
      name: toolName,
      description: `dynamically added #${extraCount}`,
      inputSchema: { type: "object", properties: {} },
    });
    await server.sendToolListChanged();
    return { content: [{ type: "text", text: `added ${toolName}` }] };
  }
  const text = req.params.arguments?.text ?? "";
  return { content: [{ type: "text", text: `echo: ${text}` }] };
});

await server.connect(new StdioServerTransport());
