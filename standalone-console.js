/*
 * Standalone fallback. Paste this entire file into DevTools Console while a
 * ChatGPT conversation is open. It downloads a plain Markdown transcript.
 */
(async () => {
  "use strict";
  const turns = Array.from(document.querySelectorAll("#thread section[data-turn-id][data-turn]"));
  const scrollRoot = document.querySelector("[data-scroll-root]");
  const originalTop = scrollRoot?.scrollTop || 0;
  const captured = new Map();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  if (!turns.length) throw new Error("No ChatGPT conversation turns found.");

  function capture() {
    for (const turn of turns) {
      const message = turn.querySelector("[data-message-author-role]");
      if (!message) continue;
      const root = message.querySelector(".markdown") ||
        message.querySelector('[data-testid="collapsible-user-message-content"]') || message;
      const text = (root.innerText || root.textContent || "").trim();
      const images = Array.from(message.querySelectorAll("img[alt]"), (image) => `[Image: ${image.alt}]`);
      if (text || images.length) {
        captured.set(turn.dataset.turnId, {
          role: message.dataset.messageAuthorRole || turn.dataset.turn,
          text: [...images, text].filter(Boolean).join("\n\n")
        });
      }
    }
  }

  try {
    capture();
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      if (!captured.has(turn.dataset.turnId)) {
        turn.scrollIntoView({ block: "center", behavior: "instant" });
        for (let attempt = 0; attempt < 25 && !captured.has(turn.dataset.turnId); attempt += 1) {
          await sleep(80);
          capture();
        }
      }
      console.info(`ChatGPT export: ${captured.size}/${turns.length}`);
    }
  } finally {
    if (scrollRoot) scrollRoot.scrollTo({ top: originalTop, behavior: "instant" });
  }

  const missing = turns.length - captured.size;
  const warning = missing ? `\n\n> Warning: ${missing} turn(s) could not be loaded.` : "";
  const body = Array.from(captured.values(), (message) =>
    `## ${message.role === "user" ? "You" : "ChatGPT"}\n\n${message.text}`
  ).join("\n\n---\n\n");
  const output = `# ChatGPT Conversation${warning}\n\n${body}\n`;
  const blobUrl = URL.createObjectURL(new Blob([output], { type: "text/markdown;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), {
    href: blobUrl,
    download: `chatgpt-conversation-${new Date().toISOString().slice(0, 10)}.md`
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  console.info(`ChatGPT export complete: ${captured.size} messages, ${missing} missing.`);
})();
