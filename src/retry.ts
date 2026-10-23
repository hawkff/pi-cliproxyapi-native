import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export function registerAutoRetry(pi: ExtensionAPI) {
  let enabled = true;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waitingContext: ExtensionContext | undefined;
  let removeInputListener: (() => void) | undefined;

  function cancel() {
    clearTimeout(timer);
    timer = undefined;
    failed = false;
    removeInputListener?.();
    removeInputListener = undefined;
    waitingContext?.ui.setStatus("cliproxyapi-auto-retry", undefined);
    waitingContext = undefined;
  }

  pi.on("agent_end", (event) => {
    failed = event.messages.findLast((message) => message.role === "assistant")?.stopReason === "error";
  });
  pi.on("agent_settled", (event, ctx) => {
    const retry = enabled && failed && !event.aborted;
    cancel();
    // One-shot modes exit after settlement.
    if (!retry || ctx.mode === "print" || ctx.mode === "json") return;

    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const retryAt = new Date(Date.now() + 10 * 60 * 1000).toLocaleTimeString();
    waitingContext = ctx;
    ctx.ui.setStatus("cliproxyapi-auto-retry", `Auto-retry at ${retryAt} · /auto-retry off to cancel`);
    const notice = `Model request failed. Retrying in 10 minutes at ${retryAt}. Use /auto-retry off to cancel.`;
    ctx.ui.notify(notice, "warning");
    if (ctx.mode === "tui") {
      removeInputListener = ctx.ui.onTerminalInput((data) => {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) cancel();
        return undefined;
      });
    }
    timer = setTimeout(
      () => {
        cancel();
        if (
          !ctx.isIdle() ||
          ctx.hasPendingMessages() ||
          ctx.sessionManager.getSessionId() !== sessionId ||
          ctx.sessionManager.getLeafId() !== leafId
        )
          return;
        pi.sendMessage(
          {
            customType: "auto-retry",
            content: "Retry the failed request and continue the unfinished task from where it stopped.",
            display: true,
          },
          { triggerTurn: true },
        );
      },
      10 * 60 * 1000,
    );
    timer.unref();
  });

  pi.on("input", cancel);
  pi.on("before_agent_start", cancel);
  pi.on("agent_start", cancel);
  pi.on("model_select", cancel);
  pi.on("user_bash", cancel);
  pi.on("session_before_compact", (event) => {
    if (event.reason === "manual") cancel();
  });
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_before_tree", cancel);
  pi.on("session_start", cancel);
  pi.on("session_shutdown", cancel);

  pi.registerCommand("auto-retry", {
    description: "Control 10-minute retries for failed model requests across all providers",
    async handler(args, ctx) {
      const action = args.trim();
      if (action !== "" && action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /auto-retry [on|off]", "error");
        return;
      }
      if (action === "off") {
        enabled = false;
        cancel();
      } else if (action === "on") enabled = true;
      ctx.ui.notify(
        `Auto-retry is ${enabled ? "on" : "off"}.${timer ? " A retry is pending." : " No retry is pending."}`,
        "info",
      );
    },
  });
}
