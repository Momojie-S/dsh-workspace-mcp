#!/usr/bin/env node
/**
 * 开发热加载脚本: 编译插件 → 输出到版本化目录 → 更新 web profile patch 的 name。
 *
 * 原理: Node ESM 缓存按模块 URL。每次编译到新目录 (dist-dev-<HHMMSS>/)，
 * patch 的 name 改成对应的 file:// URL → 不同 URL 绕过缓存 → patch HMR 触发
 * loader 重新 import → 加载最新代码。无需重启 GUI。
 *
 * 用法:
 *   node dev.mjs            # 编译一次 + 热更新到 web profile
 *   node dev.mjs --watch    # 监听 src 变化，自动编译 + 热更新
 */
import { readdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_DIR = __dirname;
const WEB_PATCH = "C:/Users/Administrator/.dsh/profiles/web/cordis.patch.yml";
const SRC_DIR = resolve(PLUGIN_DIR, "src");

function ts() {
  return String(Date.now()).slice(-6); // 简短时间戳
}

/** 用 tsc 编译到版本化目录，返回 index.js 的 file:// URL。 */
function compileVersioned() {
  const stamp = ts();
  const outDir = "dist-dev-" + stamp;
  // 用 tsc 编译到临时版本目录（--outDir 覆盖 tsconfig 的 outDir）
  execSync("npx tsc --outDir " + outDir + " --declaration false --sourcemap false", {
    cwd: PLUGIN_DIR,
    stdio: "pipe", // 静默
  });
  const outFile = resolve(PLUGIN_DIR, outDir, "index.js");
  if (!existsSync(outFile)) throw new Error("编译失败: 未找到 " + outFile);
  return pathToFileURL(outFile).href;
}

/** 更新 web patch 里 workspace-mcp 的 name 为新 URL。 */
function updatePatchName(fileUrl) {
  let content = readFileSync(WEB_PATCH, "utf8");
  // 匹配 workspace-mpc 块的 name 行
  const re = /(- id: workspace-mcp\n\s*name: )(.+)/;
  if (!re.test(content)) {
    console.error("[dev] patch 里没找到 workspace-mcp 块");
    process.exit(1);
  }
  content = content.replace(re, "$1" + fileUrl);
  writeFileSync(WEB_PATCH, content, "utf8");
  console.log("[dev] patch name → " + fileUrl.split("/").slice(-2).join("/"));
}

/** 清理旧的 dist-dev-* 目录（保留最近 8 个）。 */
function cleanOldDist() {
  const dirs = readdirSync(PLUGIN_DIR).filter(d => d.startsWith("dist-dev-")).sort();
  while (dirs.length > 8) {
    rmSync(resolve(PLUGIN_DIR, dirs.shift()), { recursive: true, force: true });
  }
}

function run() {
  console.log("[dev] 编译中...");
  const url = compileVersioned();
  updatePatchName(url);
  cleanOldDist();
  console.log("[dev] ✅ 完成，patch HMR 会自动重载");
}

if (process.argv.includes("--watch")) {
  const { watch } = await import("chokidar");
  let busy = false;
  console.log("[dev] 监听 src/ 变化...");
  watch(SRC_DIR).on("all", () => {
    if (busy) return;
    busy = true;
    try { run(); } catch (e) { console.error("[dev]", e.message); }
    setTimeout(() => { busy = false; }, 300);
  });
} else {
  run();
}
