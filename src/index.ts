/**
 * @momojie-s/dsh-workspace-mcp
 *
 * 按 workspace（session.header.cwd）自动加载/卸载 MCP server。
 * 工具注册到 agent scope，随 agent 生灭自动回收。
 *
 * 当前为探针版本：仅验证数据链路（session/created 事件能否拿到 cwd、
 * agent 生命周期挂钩点是否可达），尚未接入 MCP 连接。
 */

import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

/** 插件名（Cordis 插件标识）。 */
const name = "workspace-mcp";

/** 依赖的 Cordis 服务。 */
const inject = ["tools"];

/** 配置 schema：MCP 配置文件的发现规则。 */
const Config = z.object({
  /** 在 session.cwd 下查找的 MCP 配置文件相对路径。 */
  configFile: z.string().default(".dsh/mcp.patch.yml"),
  /** 是否启用探针日志（打印 cwd、session 事件、agent 事件）。 */
  probe: z.boolean().default(true),
});

/**
 * 插件入口。
 *
 * 探针阶段：订阅 session/created，打印 header.cwd，确认数据链路。
 * 后续：读 cwd 下的 mcp.patch.yml，按 agent scope 注册 MCP 工具。
 */
function apply(ctx: Context, config: z.infer<typeof Config>) {
  const log = (msg: string) => ctx.logger.info(`[workspace-mcp] ${msg}`);

  if (config.probe) {
    log(`插件已加载，configFile=${config.configFile}`);
  }

  // 验证点 1：session/created 能否拿到 header.cwd
  ctx.on(
    "session/created",
    (session: any) => {
      const cwd: string | undefined = session?.header?.cwd;
      log(`session/created: id=${session?.id} cwd=${cwd ?? "(无)"}`);
    },
    { global: true }
  );

  // 验证点 2：session/disposed 是否如预期（切 workspace 时是否触发）
  ctx.on(
    "session/disposed",
    (sessionId: string) => {
      log(`session/disposed: id=${sessionId}`);
    },
    { global: true }
  );
}

export { Config, apply, inject, name };
