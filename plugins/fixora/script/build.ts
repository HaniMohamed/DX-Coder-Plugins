// Bundles the plugin and its npm dependencies into a self-contained `dist/` folder that DXcoder can
// load from a path without any install step. Run with `bun run build` on a machine that has
// node_modules; copy `dist/` to restricted machines. Same shape as jira-planner's build.

import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const dist = join(root, "dist")
const pkg = JSON.parse(await Bun.file(join(root, "package.json")).text()) as {
  name: string
  version: string
  description: string
  peerDependencies: Record<string, string>
}

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

const external = ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*", "solid-js", "solid-js/*", "@opentui/core", "@opentui/core/*", "@opentui/solid", "@opentui/solid/*"]
const result = await Bun.build({
  entrypoints: [join(root, "index.ts"), join(root, "src", "rpc.ts")],
  outdir: dist,
  target: "bun",
  format: "esm",
  // The host supplies these at runtime and swaps the imports for its own instances.
  external,
  naming: "[name].js",
  sourcemap: "none",
  minify: false,
})
if (!result.success) {
  for (const log of result.logs) console.error(String(log))
  process.exit(1)
}
// The TUI entry keeps its JSX (the host transpiles .tsx with its own Solid runtime), so it is
// bundled as a single .tsx: imports of the shared src modules are inlined, host packages stay external.
const tui = await Bun.build({
  entrypoints: [join(root, "tui.tsx")],
  outdir: dist,
  target: "bun",
  format: "esm",
  external,
  naming: "tui.js",
  sourcemap: "none",
  minify: false,
  // Keep Solid's JSX transform identical to the host's: use its jsx runtime, not React's.
  jsx: { runtime: "automatic", importSource: "@opentui/solid" },
} as never)
if (!tui.success) {
  for (const log of tui.logs) console.error(String(log))
  process.exit(1)
}

// Skills are read relative to the entry file at startup, so they travel with the bundle.
await cp(join(root, "skills"), join(dist, "skills"), { recursive: true })

await writeFile(
  join(dist, "package.json"),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      type: "module",
      private: true,
      exports: { ".": "./index.js", "./server": "./index.js", "./tui": "./tui.js", "./rpc": "./rpc.js" },
      peerDependencies: pkg.peerDependencies,
      dxcoder: { bundled: true, builtAt: new Date().toISOString() },
    },
    null,
    2,
  )}\n`,
)
await cp(join(root, "README.md"), join(dist, "README.md"))
await writeFile(join(dist, "INSTALL.md"), installNotes(pkg.version))

const size = (await stat(join(dist, "index.js"))).size
console.log(`built ${join(dist, "index.js")} (${(size / 1024).toFixed(0)} KB) + rpc.js + skills/ + package.json`)
console.log(`point opencode.jsonc "plugins" at: ${dist}`)

if (process.argv.includes("--pack")) {
  const staging = join(root, ".pack")
  await rm(staging, { recursive: true, force: true })
  await cp(dist, join(staging, "fixora"), { recursive: true })
  const archive = join(root, `fixora-${pkg.version}-dist.tgz`)
  const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", staging, "fixora"], { stdout: "inherit", stderr: "inherit" })
  await rm(staging, { recursive: true, force: true })
  if (tar.exitCode !== 0) process.exit(tar.exitCode ?? 1)
  const digest = createHash("sha256").update(await Bun.file(archive).bytes()).digest("hex")
  await writeFile(`${archive}.sha256`, `${digest}  ${archive.split("/").pop()}\n`)
  console.log(`packed ${archive} (${((await stat(archive)).size / 1024).toFixed(0)} KB), sha256 ${digest.slice(0, 16)}…`)
}

function installNotes(version: string) {
  return `# fixora ${version} — offline install

This folder is a self-contained DXcoder plugin: no npm install, no network needed.

1. Put this folder somewhere permanent, e.g. /opt/dxcoder/fixora (any absolute path works).

2. Add it to opencode.jsonc (global: ~/.config/opencode/opencode.jsonc, or a project's):

   {
     "plugins": [{ "package": "/opt/dxcoder/fixora", "options": { "baseBranch": "main", "jira": { "project": "APP" } } }]
   }

   The \`dxcoder plugin add\` CLI accepts only npm/git specifiers; local folders go through the config file.

3. Configure at least one crash source MCP server (or use \`/fixora paste <file>\`):

   { "mcp": { "servers": {
       "sentry":   { "type": "remote", "url": "https://mcp.sentry.dev/mcp" },
       "firebase": { "type": "local", "command": ["npx", "-y", "firebase-tools@latest", "mcp"] }
   } } }

   Optional: a Jira server (mcp-atlassian) for tickets, a GitLab/GitHub MCP server (or the glab / gh CLI) for merge requests.

4. Restart DXcoder and run:  /fixora status
   Then list crashes:         /fixora
   Or fix one directly:       /fixora fix sentry:<issue id>

See README.md for every option.
`
}
