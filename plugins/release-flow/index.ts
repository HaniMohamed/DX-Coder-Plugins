import { Plugin } from "@opencode/plugin"

// Flow state is keyed per originating session so an interrupted run can be inspected
// or resumed later from `ctx.storage`.
export default Plugin.define({
  id: "gosi.release-flow",
  async setup(ctx) {
    await ctx.command.transform((editor) => {
      editor.add({
        name: "release-flow",
        description: "Implement a task in a worker session, wait for your approval, then ship it",
        execute: async (input) => {
          const task = input.prompt.text.trim()
          if (!task) {
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: "Usage: /release-flow <what to implement>",
              resume: false,
            })
            return
          }

          const key = `release-flow/${input.sessionID}`
          const worker = await ctx.session.create({
            parentID: input.sessionID,
            title: `release-flow: ${task}`,
            location: { directory: ctx.location.directory },
          })

          await ctx.storage.set(key, { step: "implement", workerID: worker.id, task })
          await ctx.session.prompt({
            sessionID: worker.id,
            text: `Implement the following in this repository and run the project's checks when done.\n\n${task}`,
          })
          await ctx.session.wait({ sessionID: worker.id })

          // Blocks until the user answers the approval prompt in the TUI. A rejection throws,
          // which ends the flow here and leaves the stored state at "approve" for inspection.
          await ctx.storage.set(key, { step: "approve", workerID: worker.id, task })
          await ctx.permission.assert({
            sessionID: input.sessionID,
            action: "release-flow.ship",
            resources: [ctx.location.directory],
            metadata: { task, workerID: worker.id },
          })

          await ctx.storage.set(key, { step: "ship", workerID: worker.id, task })
          await ctx.session.prompt({
            sessionID: worker.id,
            text: "The changes were approved. Commit them with a conventional commit message and open a pull request.",
          })
          await ctx.session.wait({ sessionID: worker.id })

          await ctx.storage.remove(key)
          await ctx.session.synthetic({
            sessionID: input.sessionID,
            text: `Release flow finished for "${task}". Worker session: ${worker.id}`,
            resume: false,
          })
        },
      })
    })
  },
})
