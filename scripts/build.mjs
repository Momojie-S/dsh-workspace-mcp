/**
 * Atomic build: compile to a staging directory, gate on a clean import of
 * the staged entry (apply must be a function, all imports must resolve),
 * then swap lib/ in one rename pair.
 *
 * Why: plain `tsc` emits files one by one directly into lib/. If dsh
 * restarts mid-build, the loader can import a truncated lib/index.js — an
 * empty ESM namespace has no `apply`, which aborts the entire harness boot
 * (verified 2026-08-17, rc.6). Staging + rename shrinks that window from
 * "the whole build" to "between two renames", and a failed build keeps the
 * previous good lib/.
 *
 * Shared template — copy of plugins/dsh-workspace-files/scripts/build.mjs
 * minus the client-bundle concatenation (host-only plugins).
 */
import { execSync } from 'node:child_process'
import { readFile, rm, rename, readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const stage = join(root, 'lib-tmp')
const live = join(root, 'lib')
const retired = join(root, 'lib-old')

// ---- 1. compile into staging ----
await rm(stage, { recursive: true, force: true })
execSync('tsc --outDir lib-tmp', { cwd: root, stdio: 'inherit' })

// ---- 2. import gate: the staged entry must load and export apply ----
const staged = await import(`${pathToFileURL(join(stage, 'index.js')).href}?gate=${Date.now()}`)
if (typeof staged.apply !== 'function') {
  throw new Error('build gate: staged lib/index.js has no apply export — refusing to swap')
}

// ---- 3. atomic-ish swap ----
const liveExists = await readdir(live).then(() => true, () => false)
if (liveExists) {
  await rm(retired, { recursive: true, force: true })
  await rename(live, retired)
}
try {
  await rename(stage, live)
} catch (error) {
  if (liveExists) await rename(retired, live)
  throw error
}
await rm(retired, { recursive: true, force: true })

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
console.log(`build: lib/ swapped atomically (${pkg.name})`)
