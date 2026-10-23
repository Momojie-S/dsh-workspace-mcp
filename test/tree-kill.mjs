/**
 * 树杀兜底 smoke 测试：真实拉起两层进程链（cmd → pwsh），
 * 对直接子进程调 killTree，断言孙进程一起消失（ADR-0007）。
 *
 * 场景链:
 *   1. spawn cmd.exe /c pwsh -Command "Start-Sleep 30" → 用 CIM 找到孙进程 pwsh
 *   2. killTree(直接子 pid) → ~5s 内直接子与孙进程全部消失
 *   3. killTree(不存在的 pid) → 静默不抛
 *
 * 运行: node test/tree-kill.mjs（Windows-only；其他平台直接 PASS 跳过）
 */

import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { killTree } from "../lib/tree-kill.js";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function listProcesses() {
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8", timeout: 20000 }
  );
  const parsed = JSON.parse(out.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

function descendants(rootPid, processes) {
  const result = [];
  const walk = (pid, depth) => {
    if (depth > 6) return;
    for (const p of processes) {
      if (p.ParentProcessId === pid) {
        result.push(p);
        walk(p.ProcessId, depth + 1);
      }
    }
  };
  walk(rootPid, 0);
  return result;
}

async function pollUntil(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = fn();
    if (last.ok) return last;
    await sleep(300);
  }
  fail(`poll 超时（${what}）：${last.detail ?? "条件未满足"}`);
}

if (process.platform !== "win32") {
  console.log("PASS: 非 Windows 平台，树杀为 no-op，跳过");
  process.exit(0);
}

// ---- 1. 拉起两层链 cmd → pwsh ----
const child = spawn("cmd.exe", ["/c", "pwsh", "-NoProfile", "-Command", "Start-Sleep 30"], {
  stdio: "ignore",
});
console.log(`[tree-kill] 直接子 cmd pid = ${child.pid}`);

const { grandchild } = await pollUntil(() => {
  const desc = descendants(child.pid, listProcesses());
  const pwsh = desc.find((p) => p.Name === "pwsh.exe");
  return pwsh ? { ok: true, grandchild: pwsh } : { ok: false, detail: "pwsh 未出现" };
}, 10000, "孙进程 pwsh 出现");
console.log(`[tree-kill] 孙进程 pwsh pid = ${grandchild.ProcessId}`);

// ---- 2. 树杀直接子 → 父子全灭 ----
const t0 = Date.now();
killTree(child.pid);
const { elapsed } = await pollUntil(() => {
  const procs = listProcesses();
  const cmdAlive = procs.some((p) => p.ProcessId === child.pid);
  const pwshAlive = procs.some((p) => p.ProcessId === grandchild.ProcessId);
  return !cmdAlive && !pwshAlive
    ? { ok: true, elapsed: Date.now() - t0 }
    : { ok: false, detail: `cmd 存活=${cmdAlive} pwsh 存活=${pwshAlive}` };
}, 10000, "树杀后全链消失");
if (elapsed > 8000) fail(`树杀耗时 ${elapsed}ms，超过 8s 上限`);
console.log(`步骤2 OK: 树杀后直接子与孙进程全部消失（${elapsed}ms）`);

// ---- 3. 不存在的 pid 静默不抛 ----
const deadPid = 4194303; // 不太可能复用的高位 pid
let threw = false;
try {
  killTree(deadPid);
} catch (e) {
  threw = true;
}
if (threw) fail("killTree 对不存在的 pid 抛出了异常");
await sleep(500); // 给 taskkill 异步错误回调的时间（应被内部吞掉）
console.log("步骤3 OK: 不存在的 pid 静默不抛");

console.log("PASS: 树杀兜底（两层链全灭 + 不存在 pid 不抛）通过");
process.exit(0);
