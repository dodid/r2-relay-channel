import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/core";
import {
  buildCronTarget,
  buildWebhookPath,
  buildWebhookUrl,
  resolveCommandConversationTarget,
} from "./conversation-targets.js";

export function registerRelayCommands(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "session-target",
    description: "Show cron and webhook targets for the current R2 Relay conversation.",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx) => await handleRelayCommand(ctx),
  });
}

async function handleRelayCommand(ctx: PluginCommandContext): Promise<{ text: string }> {
  const target = resolveCommandConversationTarget(ctx);

  if (!target) {
    return {
      text: [
        "I couldn't determine the current R2 Relay conversation target yet.",
        "Send at least one message through the relay in this conversation, then run /session-target again.",
      ].join("\n"),
    };
  }

  const cronTo = buildCronTarget(target.peer, target.sessionKey);
  const cronSnippet = `--announce --channel r2-relay-channel --to '${cronTo}'`;
  const webhook = buildWebhookUrl(ctx.config as any, target.peer, target.sessionKey) ?? buildWebhookPath(target.peer, target.sessionKey);

  return {
    text: [
      "To send cron output to this session, use:",
      "```TEXT",
      cronSnippet,
      "```",
      "",
      "To send webhook payloads to this session, use:",
      "```TEXT",
      webhook,
      "```",
    ].join("\n"),
  };
}
