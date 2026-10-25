// bb-plugin-quick-review — backend entry.
//
// What: an intentionally empty backend.
// Why: BB requires every plugin to declare `bb.server`, but Quick Review is a
//   pure UI layer. Marks live in the browser's localStorage and replies go
//   out through the thread's own message box, so the server has nothing to do.
// Design notes: no CLI command, agent tool, or skill is registered here on
//   purpose. BB turns plugin CLI commands and skills into agent-facing
//   documentation, and the agent must never learn this plugin exists.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Plugin factory BB calls on load.
 *
 * @param bb - the plugin API; only logging is used.
 * Post-conditions: writes one "loaded" line to the plugin log. Registers
 *   nothing, so there is nothing to dispose.
 */
export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded (frontend-only plugin)");
}
