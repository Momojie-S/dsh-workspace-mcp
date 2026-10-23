/**
 * Windows 进程树击杀兜底（dispose / 连接失败路径调用，永不抛出）。
 *
 * 为什么需要：MCP SDK 的 StdioClientTransport.close() 只作用于**直接子进程**——
 * stdin.end()（EOF）→ 2s → kill('SIGTERM') → 2s → kill('SIGKILL')，Windows 上
 * 即 TerminateProcess 单进程强杀。多层命令链（uvx→uv→exe→python）中不读 stdin
 * 的链成员（典型：uv 解析阶段）收不到 EOF，直接子进程被杀后其余层成为孤儿，
 * 只能等它们自行走完流程或被外部清杀（2026-10-23 MomoYu workspace 重连风暴实录，
 * 见 docs/design/decisions/0007-dispose-tree-kill.md 的背景节）。
 *
 * taskkill 参数含义：
 *   /PID <pid>  目标进程 id（transport 的直接子进程）
 *   /T          连同其全部后代一起结束（树杀；孤儿化问题的正面解）
 *   /F          强制结束（ TerminateProcess 语义，不给优雅退出机会——
 *               优雅退出已由 transport.close() 的 EOF 软回收负责，此处是兜底）
 *
 * 永不抛出：本函数运行在 dispose / 连接失败路径上，任何异常都必须吞掉——
 * 树杀失败只是退回 SDK 原有行为（EOF 软回收 + 只杀直接子进程），不能把
 * dispose 或重连循环炸掉。
 */

import { spawn } from "node:child_process";

export function killTree(pid: number): void {
  try {
    if (process.platform !== "win32") return;
    if (!Number.isInteger(pid) || pid <= 0) return;
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    // 吞掉 taskkill 自身的异步错误（目标已死时 taskkill 非零退出属预期）
    child.on("error", () => {});
  } catch {
    // 永不抛出：树杀失败退回 SDK 原有软回收行为
  }
}
