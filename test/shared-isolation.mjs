/**
 * 方案C §6.2 隔离 smoke：不同 configPath、同名 server 不共享
 * （key 拼装错误导致的静默跨 workspace 共享是最恶劣故障模式，此测试钉死）。
 *
 * 运行: node test/shared-isolation.mjs（需先 npm run build）
 */

import {
  connKeyOf,
  counterEntryYml,
  expect,
  makeAgentCtx,
  makeRegistry,
  makeTempWorkspace,
  pidVia,
  writeYml,
} from "./shared-helpers.mjs";

const log = (msg) => console.error(`[isolation] ${msg}`);

const wsA = await makeTempWorkspace("iso-a");
const wsB = await makeTempWorkspace("iso-b");
const registry = makeRegistry({ idleDropMs: 60_000 });

try {
  await writeYml(wsA.ymlPath, counterEntryYml("alpha"));
  await writeYml(wsB.ymlPath, counterEntryYml("alpha"));
  const a = makeAgentCtx();
  const b = makeAgentCtx();
  registry.registerAgentPresence("agent-a", wsA.cwd, a.ctx);
  registry.registerAgentPresence("agent-b", wsB.cwd, b.ctx);
  await registry.ensureAgentServers("agent-a", wsA.cwd, a.ctx);
  await registry.ensureAgentServers("agent-b", wsB.cwd, b.ctx);
  await registry.whenSettled();

  // 同名 server "alpha"，不同 configPath → 必须两条独立连接
  expect(
    registry.connectionKeys().length === 2,
    `不同 configPath 同名 server 应两条连接，实际 ${registry.connectionKeys().length}`
  );
  // 等首次 fetch 完成（ready = 首试结果，含 fetch）
  await registry.readyOf(connKeyOf(wsA.ymlPath, "alpha"));
  await registry.readyOf(connKeyOf(wsB.ymlPath, "alpha"));
  await registry.whenSettled();
  const pa = await pidVia(a.registered, "alpha");
  const pb = await pidVia(b.registered, "alpha");
  expect(pa !== pb, `不同 workspace 的同名 server 不得共享进程（${pa} vs ${pb}）`);
  // 工具注册严格 per-agent
  expect(a.registered.size === 4, `A 应注册 4 个工具（counter-server），实际 ${a.registered.size}`);
  expect(b.registered.size === 4, `B 应注册 4 个工具（counter-server），实际 ${b.registered.size}`);
  log(`OK: 同名 server 跨 workspace 隔离（#${pa} vs #${pb}）`);
  console.log("PASS: 不同 configPath 同名 server 不共享");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await registry.disposeAll();
  await wsA.cleanup();
  await wsB.cleanup();
}
