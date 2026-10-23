/**
 * 方案C 共享连接 smoke 测试的公共助手：临时 workspace、yml 写入、
 * registry 构造、mock agentCtx、pid 存活探针、轮询断言。
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { WorkspaceMcpRegistry, connKeyOf } from "../lib/registry.js";

export { connKeyOf, sleep };

export const counterServer = fileURLToPath(
  new URL("./fixtures/counter-server.mjs", import.meta.url)
);

export function expect(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

export async function pollUntil(fn, { timeoutMs, intervalMs = 100, what }) {
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
  throw new Error(`FAIL: poll 超时（${what}）: ${lastError?.message ?? lastError ?? "条件未满足"}`);
}

/** mock agent 上下文：tools.register 记录定义，disposer 删除（可注入失败注入器）。 */
export function makeAgentCtx(onRegister) {
  const registered = new Map();
  const ctx = {
    tools: {
      register(def) {
        if (onRegister) onRegister(def);
        registered.set(def.name, def);
        return () => registered.delete(def.name);
      },
    },
  };
  return { ctx, registered };
}

export async function makeTempWorkspace(tag) {
  const base = await mkdtemp(join(tmpdir(), "ws-mcp-"));
  const cwd = join(base, tag);
  await mkdir(join(cwd, ".dsh"), { recursive: true });
  const ymlPath = join(cwd, ".dsh", "mcp.servers.yml");
  const cleanup = async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  };
  return { cwd, ymlPath, cleanup };
}

/** counter-server 的 yml 条目（gen 后缀进 args：内容变化可被深比较识别）。 */
export function counterEntryYml(serverName, gen = "") {
  const args = gen
    ? `${JSON.stringify(counterServer)}, ${JSON.stringify(`--gen-${gen}`)}`
    : JSON.stringify(counterServer);
  return `  ${serverName}:\n    transport: stdio\n    command: ${JSON.stringify(process.execPath)}\n    args: [${args}]\n`;
}

export async function writeYml(ymlPath, body) {
  await writeFile(ymlPath, `servers:\n${body}`);
}

export function makeRegistry({
  sink,
  idleDropMs = 400,
  reloadDebounceMs = 60,
  maxAttempts = 5,
} = {}) {
  const logs = sink ?? [];
  const registry = new WorkspaceMcpRegistry({
    configFile: ".dsh/mcp.servers.yml",
    log: (msg) => {
      logs.push(msg);
      console.error(`[t] ${msg}`);
    },
    reloadDebounceMs,
    idleDropMs,
    reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 150, maxAttempts },
  });
  registry.logs = logs;
  return registry;
}

/** 经某 agent 的注册表调用 server 的 pid 工具（无 pid 工具则抛错）。 */
export async function pidVia(registered, serverName) {
  const def = registered.get(`mcp__${serverName}__pid`);
  if (!def) throw new Error(`FAIL: pid 未注册 (${serverName})`);
  const r = await def.execute({}, {});
  return Number(r.content[0].text);
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPidDead(pid, timeoutMs = 8000) {
  await pollUntil(() => (!pidAlive(pid) ? true : undefined), {
    timeoutMs,
    what: `pid ${pid} 消亡`,
  });
}
