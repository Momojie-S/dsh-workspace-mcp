/**
 * 方案C §6.12 插件级 dispose（fiber dispose / HMR）smoke：
 * 全部连接杀净、watcher 关闭、path 状态一并清、零孤儿进程、工具全卸载。
 *
 * 运行: node test/shared-fiber-dispose.mjs（需先 npm run build）
 */

import {
  connKeyOf,
  counterEntryYml,
  expect,
  makeAgentCtx,
  makeRegistry,
  makeTempWorkspace,
  pidAlive,
  pidVia,
  pollUntil,
  writeYml,
} from "./shared-helpers.mjs";

const log = (msg) => console.error(`[fiber-dispose] ${msg}`);

const ws = await makeTempWorkspace("fiber-dispose");
const registry = makeRegistry({ idleDropMs: 60_000 });

try {
  await writeYml(ws.ymlPath, counterEntryYml("alpha") + counterEntryYml("beta"));
  const a = makeAgentCtx();
  const b = makeAgentCtx();
  for (const [id, m] of [
    ["agent-a", a],
    ["agent-b", b],
  ]) {
    registry.registerAgentPresence(id, ws.cwd, m.ctx);
    await registry.ensureAgentServers(id, ws.cwd, m.ctx);
  }
  await registry.whenSettled();
  await registry.readyOf(connKeyOf(ws.ymlPath, "alpha"));
  await registry.readyOf(connKeyOf(ws.ymlPath, "beta"));
  await registry.whenSettled();
  const alphaPid = await pidVia(a.registered, "alpha");
  const betaPid = await pidVia(b.registered, "beta");
  expect(registry.connectionKeys().length === 2, `dispose 前应 2 条连接`);
  expect(registry.pathKeys().length === 1, `dispose 前应 1 个 path 状态`);

  // ---- 插件级 dispose（fiber dispose 等价） ----
  await registry.disposeAll();

  expect(registry.connectionKeys().length === 0, `disposeAll 后连接应清空`);
  expect(registry.pathKeys().length === 0, `disposeAll 后 path 状态应清空`);
  expect(a.registered.size === 0, `A 的注册应全部卸载`);
  expect(b.registered.size === 0, `B 的注册应全部卸载`);
  await pollUntil(
    () => (!pidAlive(alphaPid) && !pidAlive(betaPid) ? true : undefined),
    { timeoutMs: 8000, what: `两个 server 进程（${alphaPid}/${betaPid}）消亡` }
  );
  log(`OK: disposeAll → 连接/watcher/path 状态清空，进程 ${alphaPid}/${betaPid} 零残留`);

  console.log("PASS: 插件级 dispose 全清理 + 零孤儿进程 通过");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await ws.cleanup();
}
