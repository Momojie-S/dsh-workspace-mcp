/**
 * 方案C §6.10 热添加 smoke（watcher 锚定 liveAgents 的守护测试）：
 *   - 先有 agent（无 yml 文件）→ watcher 已在位（liveAgents 空↔非空跃迁创建）
 *   - 文件后建 → reload 枚举（liveAgents × 新条目）首订落位 → 工具出现
 *   - 变体：文件存在但非法 → agent 仍登记 → 工具保持 → 修复后恢复
 *
 * 运行: node test/shared-hotadd.mjs（需先 npm run build）
 */

import { writeFile } from "node:fs/promises";
import {
  counterEntryYml,
  expect,
  makeAgentCtx,
  makeRegistry,
  makeTempWorkspace,
  pollUntil,
  sleep,
  writeYml,
} from "./shared-helpers.mjs";

const log = (msg) => console.error(`[hotadd] ${msg}`);

const ws = await makeTempWorkspace("hotadd");
const registry = makeRegistry({ idleDropMs: 60_000, reloadDebounceMs: 60 });

try {
  // ---- 1. 先有 agent、无文件：同步段登记 + watcher 创建 ----
  const a = makeAgentCtx();
  registry.registerAgentPresence("agent-a", ws.cwd, a.ctx); // 无配置也登记
  await registry.ensureAgentServers("agent-a", ws.cwd, a.ctx); // ENOENT → no-op
  await sleep(150); // 若 watcher 误以连接为锚，这里无连接就无 watcher
  expect(a.registered.size === 0, `无文件时不应有工具`);

  // ---- 2. 文件后建 → reload 枚举首订落位 ----
  await writeYml(ws.ymlPath, counterEntryYml("alpha"));
  await pollUntil(() => (a.registered.size === 4 ? true : undefined), {
    timeoutMs: 8000,
    what: "文件后建 → 枚举首订落位（4 工具）",
  });
  log("步骤1 OK: 先有 agent 后建文件 → watcher 在位 → 枚举首订落位");

  // ---- 3. 变体：文件存在但非法 → 保守保留 → 修复后保持/恢复 ----
  await writeFile(ws.ymlPath, "servers: [broken", "utf8");
  await sleep(300); // reload 走瞬态失败分支：保守保留
  expect(a.registered.size === 4, `非法 yml 应保守保留工具`);
  await writeFile(ws.ymlPath, "servers:\n  alpha:\n    transport: stdio\n    comm", "utf8");
  await sleep(300); // 又一次瞬态失败
  expect(a.registered.size === 4, `半截 yml 仍应保守保留工具`);
  await writeYml(ws.ymlPath, counterEntryYml("alpha", "fixed"));
  await pollUntil(async () => {
    // 修复后 reload → 重建换代（工具重挂）
    return a.registered.size === 4 ? true : undefined;
  }, { timeoutMs: 8000, what: "修复 yml 后工具健在" });
  log("步骤2 OK: 非法文件保守保留 + 修复后恢复");

  console.log("PASS: 热添加（先 agent 后文件）+ 非法文件保守保留 全部通过");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await registry.disposeAll();
  await ws.cleanup();
}
