// Bundles the plugin and its npm dependencies into a self-contained `dist/` folder that DXcoder can
// load from a path without any install step. Run with `bun run build` on a machine that has
// node_modules; copy `dist/` to restricted machines.

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

const result = await Bun.build({
  entrypoints: [join(root, "index.ts")],
  outdir: dist,
  target: "bun",
  format: "esm",
  // The host supplies these at runtime and swaps the imports for its own instances.
  external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"],
  naming: "index.js",
  sourcemap: "none",
  minify: false,
})
if (!result.success) {
  for (const log of result.logs) console.error(String(log))
  process.exit(1)
}

// The skill is read relative to the entry file at startup, so it travels with the bundle.
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
      exports: { ".": "./index.js", "./server": "./index.js" },
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
console.log(`built ${join(dist, "index.js")} (${(size / 1024 / 1024).toFixed(1)} MB) + skills/ + package.json`)
console.log(`point opencode.jsonc "plugins" at: ${dist}`)

// `bun run pack` additionally produces a tarball whose top-level folder is `jira-planner/`.
if (process.argv.includes("--pack")) {
  const staging = join(root, ".pack")
  await rm(staging, { recursive: true, force: true })
  await cp(dist, join(staging, "jira-planner"), { recursive: true })
  const archive = join(root, `jira-planner-${pkg.version}-dist.tgz`)
  const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", staging, "jira-planner"], { stdout: "inherit", stderr: "inherit" })
  await rm(staging, { recursive: true, force: true })
  if (tar.exitCode !== 0) process.exit(tar.exitCode ?? 1)
  const digest = createHash("sha256").update(await Bun.file(archive).bytes()).digest("hex")
  await writeFile(`${archive}.sha256`, `${digest}  ${archive.split("/").pop()}\n`)
  console.log(`packed ${archive} (${((await stat(archive)).size / 1024 / 1024).toFixed(1)} MB), sha256 ${digest.slice(0, 16)}…`)
}

function installNotes(version: string) {
  return `# jira-planner ${version} — offline install

This folder is a self-contained DXcoder plugin: no npm install, no network needed.

1. Put this folder somewhere permanent, e.g. /opt/dxcoder/jira-planner (any absolute path works).

2. Add it to opencode.jsonc (global: ~/.config/opencode/opencode.jsonc, or a project's):

   {
     "plugins": [{ "package": "/opt/dxcoder/jira-planner", "options": {} }]
   }

   The \`dxcoder plugin add\` CLI accepts only npm/git specifiers; local folders go through the config file.

3. Make sure the Jira MCP server (Python) is installed and configured, otherwise the plugin stops
   with instructions:

   pip install mcp-atlassian        # offline: pip install --no-index --find-links <wheels dir> mcp-atlassian

   {
     "mcp": { "servers": { "jira": {
       "type": "local", "command": ["mcp-atlassian"],
       "environment": { "JIRA_URL": "https://jira.example.com", "JIRA_PERSONAL_TOKEN": "<PAT>", "JIRA_SSL_VERIFY": "true" }
     } } }
   }

4. Restart DXcoder and run:  /jira-planner status
   Then plan a story:        /jira-planner PROJ-123

Optional plugin options (inside "options"): jira { url, token | username+password, sslVerify },
storyPointsFieldId, storyPointsFieldNames, subtaskIssueType, label, summaryPrefix, workerAgent,
workerShell ("deny" | "ask" | "allow"), maxAttachmentMB, gitignore. See README.md for details.
`
}
