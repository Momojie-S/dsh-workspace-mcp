# ADR-0007：dispose 与连接失败路径的 Windows 进程树击杀兜底

状态：accepted（2026-10-23）

## 背景

2026-10-23 MomoYu workspace 的 MCP 重连风暴（comfy-mcp/bili，一小时堆积 100+ 进程、
python 总 WorkingSet 约 16GB，实录见 momojie-assistant ops/home/log/2026-10.md 10-23 条）
暴露了一个结构性缺口：

- MCP SDK 的 `StdioClientTransport.close()` 只作用于**直接子进程**——`stdin.end()`
  （EOF）→ 2s → `kill('SIGTERM')` → 2s → `kill('SIGKILL')`，Windows 上即
  TerminateProcess 单进程强杀，对进程树没有任何处理。
- 多层命令链（uvx→uv→exe→python）里不读 stdin 的链成员（典型：uv 解析阶段，
  实测可停滞 60s+）收不到 EOF；直接子进程被杀后其余层成为孤儿。Windows 没有
  进程树自动回收，孤儿只能自行走完流程或被外部清杀。
- 本插件的 supervisor（ADR-0004，移植官方 dsh-mcp-client）与官方同源，官方
  `dsh-mcp-client` 存在同样弱点（lib 内无任何树杀逻辑，本实现可上游化）。

## 备选

| 方案 | 结论 |
|------|------|
| 仅配置层规避（uv tool install 固定 exe，消灭多层链） | ✅ 值得做（方案 A），但只覆盖 uvx 形态；npx/cmd 包装/未来任何多层命令依旧裸奔 |
| 维持现状，靠 EOF 软回收 | ❌ 实测健康链 EOF 回收可靠（含生产侧 13:29 停用后 112→10 的批量清零），但「解析中途被杀」的窗口覆盖不到，孤儿靠对方自行退场，时序不可控 |
| dispose 与失败路径树杀兜底（本决策） | ✅ 一处修复惠及所有 stdio server 与未来任何命令形态；不改变正常路径行为 |

## 决策

- 新增 `src/tree-kill.ts`：`killTree(pid)` 仅 Windows 生效（`taskkill /PID <pid> /T /F`
  ，树杀 + 强杀），全链路 try/catch 永不抛出；其他平台 no-op。
- supervisor 闭包跟踪当前代 transport（与 `client`/`clientClosed` 配对置位清位）：
  - `dispose()` 在 `await current.close()` **之前**对 `transport.pid` 树杀——树杀
    立即覆盖「解析中途/正忙/不读 stdin」所有形态，随后 `close()` 只做协议与流
    清理（进程已死时其 closePromise 立即 resolve）；
  - `connectGeneration` 失败路径在 `generation.close()` 之前同样树杀——重试风暴
    场景下每个失败尝试不再孤儿化一条解析中的链。
- EOF 软回收仍是主路径：健康链上 `stdin.end()` 即全链优雅退出（实测含生产侧
  批量回收），树杀只是兜底，不改变正常关闭行为。

## 后果

- 与官方 dsh-mcp-client 行为分化：官方有同样的只杀单进程弱点，本实现可上游化。
- 孤儿窗口收敛：解析中的链被杀时由 `taskkill /T` 立即整树覆盖，不再依赖对方
  「自行走完流程」的时序。
- 失败重试周期缩短：树杀让失败一代的关闭立即完成，不再等 SDK 的 EOF 2s+2s
  击杀序列（对不读 stdin 的进程，该序列本就走满 4s）。
- 非 Windows 平台行为不变（`killTree` no-op，依赖 POSIX 侧进程组/EOF 语义，
  本插件当前不在此展开）。
- 验证：`test/tree-kill.mjs` 真实两层链（cmd→pwsh）树杀全灭 + 不存在 pid 不抛；
  既有三条 supervisor smoke 全绿（树杀对单进程命令等价于原行为）。
