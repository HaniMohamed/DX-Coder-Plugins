# release-flow

Adds a `/release-flow <task>` command to DXcoder.

1. Creates a child worker session and asks it to implement the task and run checks.
2. Waits for the worker to go idle.
3. Asks you to approve shipping (permission action `release-flow.ship`). Rejecting stops the flow.
4. Tells the worker to commit and open a pull request, then reports back in the originating session.

Progress is stored under `release-flow/<sessionID>` in plugin storage while a run is active.

Install:

```sh
dxcoder plugin add 'git+https://<your-git-host>/<org>/dxcoder-plugins.git#path:plugins/release-flow'
```
