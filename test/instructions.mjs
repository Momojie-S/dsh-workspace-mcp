/**
 * server instructions 注入测试（ADR-0010）：连接层快照 + per-agent scoped
 * section 注册 + 退订清理 + 超限按连接失败处理。不经 DSH host，经 registry
 * 直驱 supervisor 全链路（入口 = ensureAgentServersInline + readyOf）。
 *
 * 场景链:
 *   1. 短 instructions server 连接 → 工具注册 + section 注册
 *      （name/order/interpolate/text 包装格式逐一断言）
 *   2. section text() 惰性读快照
 *   3. agentDisposed 退订 → section disposer 被调、工具卸载
 *   4. 无 systemPrompt 服务的 agentCtx → 跳过注入、工具照常（防御路径）
 *   5. 超长 instructions + maxInstructionBytes=1024 → 连接失败、无注册
 *   6. 超长 instructions 默认上限 32KB 内放行 → 正常注册（长文本合法）
 *
 * 运行: node test/instructions.mjs（需先 npm run build）
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { WorkspaceMcpRegistry, connKeyOf } from "../lib/registry.js";

const serverScript = fileURLToPath(new URL("./fixtures/instructions-server.mjs", import.meta.url));

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function expect(cond, msg) {
  if (!cond) fail(msg);
}

async function pollUntil(fn, { timeoutMs, intervalMs = 150, what }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastError = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`poll 超时（${what}）: ${lastError?.message ?? lastError ?? "条件未满足"}`);
}

/** 带 systemPrompt 记录面的 mock agentCtx：section 注册/卸载与工具同构。 */
function makeAgentCtxWithPrompt() {
  const registered = new Map();
  const sections = new Map();
  const disposedSections = [];
  const ctx = {
    tools: {
      register(def) {
        registered.set(def.name, def);
        return () => registered.delete(def.name);
      },
    },
    systemPrompt: {
      getSectionOrder: (name) => (name === "MCP_SERVERS" ? 3100 : 0),
      section(section) {
        sections.set(section.name, section);
        return () => {
          sections.delete(section.name);
          disposedSections.push(section.name);
        };
      },
    },
  };
  return { ctx, registered, sections, disposedSections };
}

function makeRegistry(logs) {
  return new WorkspaceMcpRegistry({
    configFile: ".dsh/mcp.servers.yml",
    log: (msg) => {
      logs.push(msg);
      console.error(`[t] ${msg}`);
    },
    reloadDebounceMs: 500,
    idleDropMs: 60_000,
    reconnect: { enabled: true, initialDelayMs: 80, maxDelayMs: 300, maxAttempts: 4 },
  });
}

async function withWorkspace(tag, fn) {
  const base = await mkdtemp(join(tmpdir(), "ws-mcp-instr-"));
  const cwd = join(base, tag);
  await mkdir(join(cwd, ".dsh"), { recursive: true });
  try {
    return await fn(cwd);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

const stdio = (args, extra = {}) => ({
  transport: "stdio",
  command: process.execPath,
  args: [serverScript, ...(args ?? [])],
  toolCallTimeoutMs: 5000,
  ...extra,
});

console.log("== 场景1-3: 短 instructions → section 注册 / 惰性快照 / 退订清理 ==");
await withWorkspace("ws", async (cwd) => {
  const logs = [];
  const registry = makeRegistry(logs);
  const { ctx, registered, sections, disposedSections } = makeAgentCtxWithPrompt();
  const key = connKeyOf(resolve(cwd, ".dsh/mcp.servers.yml"), "instr");

  try {
    registry.registerAgentPresence("agent-1", cwd, ctx);
    await registry.ensureAgentServersInline("agent-1", cwd, ctx, { instr: stdio() });
    await pollUntil(() => (registered.size === 1 ? true : undefined), {
      timeoutMs: 15000,
      what: "工具注册",
    });
    await pollUntil(() => (sections.size === 1 ? true : undefined), {
      timeoutMs: 5000,
      what: "section 注册",
    });

    // ---- 1. section 形状（与官方 dsh-mcp-client 的 section 逐项对齐） ----
    const section = sections.get("mcp:instr");
    expect(section, "section 名应为 mcp:instr");
    expect(section.order === 3100, `order 应取 MCP_SERVERS=3100，实际 ${section.order}`);
    expect(section.interpolate === false, "interpolate 应为 false（字面文本）");
    const wrapped = section.text({});
    const expected = "### MCP server: instr\n\n全局口径：截图统一 1920*1080；矩形用 (x1, y1, x2, y2)。";
    expect(wrapped === expected, `text() 包装不符:\n  实际: ${JSON.stringify(wrapped)}\n  期望: ${JSON.stringify(expected)}`);
    console.log("步骤1 OK: section 注册，name/order/interpolate/text 全部符合");

    // ---- 2. text() 惰性：多读几次结果稳定（快照语义） ----
    expect(section.text({}) === wrapped, "text() 应稳定返回同一快照");
    console.log("步骤2 OK: text() 惰性读快照，多次求值稳定");

    // ---- 3. 退订 → section 与工具一起清理 ----
    registry.agentDisposed("agent-1");
    await registry.whenSettled();
    expect(registered.size === 0, `退订后应无工具，实际 ${registered.size}`);
    expect(sections.size === 0, `退订后应无 section，实际 ${sections.size}`);
    expect(disposedSections.includes("mcp:instr"), "退订应调 section 的 disposer");
    console.log("步骤3 OK: agentDisposed 退订，section 与工具同步清理");
  } finally {
    await registry.disposeAll().catch(() => {});
  }
});

console.log("== 场景4: 无 systemPrompt 服务 → 跳过注入、工具照常 ==");
await withWorkspace("ws-nosp", async (cwd) => {
  const logs = [];
  const registry = makeRegistry(logs);
  const registered = new Map();
  const ctx = {
    tools: {
      register(def) {
        registered.set(def.name, def);
        return () => registered.delete(def.name);
      },
    },
  };

  try {
    registry.registerAgentPresence("agent-bare", cwd, ctx);
    await registry.ensureAgentServersInline("agent-bare", cwd, ctx, { bare: stdio() });
    await pollUntil(() => (registered.size === 1 ? true : undefined), {
      timeoutMs: 15000,
      what: "无 systemPrompt 时工具注册",
    });
    expect(
      logs.some((m) => m.includes("无 systemPrompt 服务，跳过 instructions 注入")),
      "应记跳过日志"
    );
    console.log("步骤4 OK: 防御路径——跳过注入且不影响工具");
  } finally {
    await registry.disposeAll().catch(() => {});
  }
});

console.log("== 场景5: 超长 instructions + maxInstructionBytes=1024 → 连接失败 ==");
await withWorkspace("ws-over", async (cwd) => {
  const logs = [];
  const registry = makeRegistry(logs);
  const { ctx, registered, sections } = makeAgentCtxWithPrompt();
  const key = connKeyOf(resolve(cwd, ".dsh/mcp.servers.yml"), "big");

  try {
    registry.registerAgentPresence("agent-over", cwd, ctx);
    await registry.ensureAgentServersInline("agent-over", cwd, ctx, {
      big: stdio(["long"], { maxInstructionBytes: 1024 }),
    });
    const ready = await registry.readyOf(key);
    expect(ready, "ready 缺失");
    // 连接失败后后台重连（每次都超限），ready 首试结果应携带错误
    await pollUntil(() => (ready.error ? true : undefined), {
      timeoutMs: 15000,
      what: "ready 报告超限错误",
    });
    expect(
      String(ready.error?.message ?? "").includes("maxInstructionBytes"),
      `错误应指向 maxInstructionBytes，实际: ${ready.error?.message}`
    );
    expect(registered.size === 0, `超限连接不应注册工具，实际 ${registered.size}`);
    expect(sections.size === 0, `超限连接不应注册 section，实际 ${sections.size}`);
    console.log("步骤5 OK: 超限按连接失败处理，无任何注册");
  } finally {
    await registry.disposeAll().catch(() => {});
  }
});

console.log("== 场景6: 超长 instructions + 显式放大上限 → 正常注入 ==");
await withWorkspace("ws-long", async (cwd) => {
  const logs = [];
  const registry = makeRegistry(logs);
  const { ctx, registered, sections } = makeAgentCtxWithPrompt();

  try {
    registry.registerAgentPresence("agent-long", cwd, ctx);
    await registry.ensureAgentServersInline("agent-long", cwd, ctx, {
      long: stdio(["long"], { maxInstructionBytes: 200_000 }),
    });
    await pollUntil(() => (sections.size === 1 ? true : undefined), {
      timeoutMs: 15000,
      what: "长文本 section 注册",
    });
    const section = sections.get("mcp:long");
    expect(section, "section 名应为 mcp:long");
    const wrapped = section.text({});
    expect(wrapped.startsWith("### MCP server: long\n\nFILLER"), "长文本包装头部不符");
    expect(
      Buffer.byteLength(wrapped, "utf8") > 50_000,
      `长文本应完整带入（>50KB），实际 ${Buffer.byteLength(wrapped, "utf8")} 字节`
    );
    console.log("步骤6 OK: 显式放大上限后长文本正常注入");
  } finally {
    await registry.disposeAll().catch(() => {});
  }
});

console.log("PASS: instructions 注入全链路（注册/快照/清理/防御/超限/放行）通过");
process.exit(0);
