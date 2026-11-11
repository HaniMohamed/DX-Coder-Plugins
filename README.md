# DXcoder plugins

Separately shipped plugins for DXcoder. Each directory under `plugins/` is one
installable plugin; none of them are bundled with DXcoder itself.

| Plugin                                   | Directory               |
| ---------------------------------------- | ----------------------- |
| [release-flow](plugins/release-flow/README.md) | `plugins/release-flow`  |

## Install on a machine

Plugins are installed from Git, not npm. The `#path:` fragment selects the plugin
directory; add `#<tag>&path:...` style refs if you want to pin a release.

```sh
dxcoder plugin add 'git+https://<your-git-host>/<org>/dxcoder-plugins.git#path:plugins/release-flow'
dxcoder plugin update   # pull a newer revision later
dxcoder plugin remove 'git+https://<your-git-host>/<org>/dxcoder-plugins.git#path:plugins/release-flow'
```

The install writes one entry into the user's global DXcoder config, so the plugin
is active in every project on that machine.

## Local development

Point a project at the checked-out plugin directory in its `opencode.jsonc`:

```jsonc
{
  "plugins": ["../dxcoder-plugins/plugins/release-flow"]
}
```

Then run the DXcoder TUI from the `gosi_coder` worktree with `bun run dev:live <project>`.
Edits to the plugin files are picked up on the next reload.

Type-checking expects the DXcoder sources at `../gosi_coder` (sibling of this repo)
with its dependencies installed, because `@opencode/plugin` and `effect` are resolved
from there via `tsconfig.base.json` paths:

```sh
bun install
bun run typecheck
```

## Adding a plugin

1. Copy `plugins/release-flow` to `plugins/<name>`.
2. Set `name` in its `package.json`; keep `@opencode/plugin` and `effect` as
   `peerDependencies` and never bundle them.
3. Export `index.ts` directly (no build step) and extend `../../tsconfig.base.json`.
4. Add the row above.
