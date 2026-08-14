/**
 * @momojie-s/dsh-workspace-mcp
 *
 * 按 workspace（session.header.cwd）自动加载/卸载 MCP server。
 *
 * 当前为增强探针：探测所有候选挂钩点，摸清数据链路，
 * 确定 MCP 加载应挂在 session/created 还是 agent 创建路径。
 */

import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

const name = "workspace-mcp";
const inject = ["tools"];

interface PluginConfig {
  configFile: string;
  probe: boolean;
}

const Config = z.object({
  configFile: z.string().default(".dsh/mcp.patch.yml"),
  probe: z.boolean().default(true),
});

function apply(ctx: Context, config: PluginConfig) {
  const log = (msg: string) => console.error(`[ws-mcp] ${msg}`);
  const warn = (msg: string) => console.error(`[ws-mcp][warn] ${msg}`);

  console.error("[ws-mcp] apply() 被调用，插件已加载");
  if (!config.probe) return;
  log("探针已加载");

  const bus = ctx as any;

  // === 探测点 1: session/created ===
  // 目标：确认能拿到 session.header.cwd
  bus.on(
    "session/created",
    (session: any) => {
      const cwd = session?.header?.cwd;
      const sid = session?.id;
      log(`PROBE session/created: id=${sid} cwd=${cwd ?? "(无)"}`);
      // 探测 session 对象结构，看有没有 agent 关联
      const keys = session ? Object.keys(session).slice(0, 15).join(",") : "(null)";
      log(`PROBE session keys: ${keys}`);
    },
    { global: true }
  );

  // === 探测点 2: session/disposed ===
  // 目标：确认切 workspace 时是否触发（预判：不触发）
  bus.on(
    "session/disposed",
    (sessionId: string) => {
      log(`PROBE session/disposed: id=${sessionId}`);
    },
    { global: true }
  );

  // === 探测点 2.5: agent/created (关键！agent-scoped 工具注册的钩子点) ===
  // 目标：确认能拿到 agent.ctx (scoped) 和 agent.session.header.cwd
  bus.on(
    "agent/created",
    ({ agent }: any) => {
      const agentCtx = agent?.ctx;
      const session = agent?.session;
      const cwd = session?.header?.cwd;
      const hasTools = typeof agentCtx?.tools?.register === "function";
      log(`PROBE agent/created: cwd=${cwd ?? "(无)"} agent.ctx.tools.register=${hasTools}`);
      // 探测 agent 对象暴露了什么
      const akeys = agent ? Object.getOwnPropertyNames(agent).slice(0, 20).join(",") : "(null)";
      log(`PROBE agent keys: ${akeys}`);
    },
    { global: true }
  );

  // === 探测点 3: tools.register 调用监控 ===
  // 目标：看 web 对话期间有哪些工具被注册、注册时的 ctx 是否带 scope/agent
  // 用拦截方式观察，不影响原行为
  try {
    const tools = (ctx as any).tools;
    if (tools && typeof tools.register === "function" && !tools.__wsProbed) {
      const origRegister = tools.register.bind(tools);
      tools.__wsProbed = true;
      tools.register = (def: any) => {
        const tname = def?.name ?? "?";
        if (typeof tname === "string" && tname.startsWith("mcp__")) {
          log(`PROBE tools.register: ${tname}`);
        }
        return origRegister(def);
      };
    }
  } catch (e: any) {
    warn(`PROBE tools hook 失败: ${e?.message}`);
  }

  // === 探测点 4: domain/changed (workspace 切换信号) ===
  // 目标：看切 workspace 时 domain 层是否发出事件
  bus.on(
    "domain/changed",
    (change: any) => {
      if (change?.domain === "workspace" || change?.table === "workspaces") {
        log(`PROBE domain/changed workspace: op=${change?.operation} id=${change?.id ?? "?"}`);
      }
    },
    { global: true }
  );
}

export { Config, apply, inject, name };