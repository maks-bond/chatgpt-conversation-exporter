(() => {
  "use strict";

  const { sleep, normalize, blocksToMarkdown, toIsoTimestamp, sendProgress, isCancelled, register } = globalThis.ChatExport;

  const TURN_SELECTOR = "#thread section[data-turn-id][data-turn]";
  const MESSAGE_SELECTOR = "[data-message-author-role]";
  const SCROLL_SELECTOR = "[data-scroll-root]";
  const WAIT_PER_TURN_MS = 2500;
  const CONVERSATION_ID_PATTERN = /\/c\/([a-f0-9-]{36})(?:[/?#]|$)/i;
  const EXPORTABLE_METADATA_CONTENT_TYPES = new Set(["text", "multimodal_text", "code"]);

  function extractMessage(turn) {
    const message = turn.querySelector(MESSAGE_SELECTOR);
    if (!message) return null;
    const role = message.dataset.messageAuthorRole || turn.dataset.turn || "unknown";
    const markdownRoot = message.querySelector(".markdown") ||
      message.querySelector('[data-testid="collapsible-user-message-content"]') || message;
    const attachments = Array.from(message.querySelectorAll("img[alt]"))
      .map((image) => image.getAttribute("alt"))
      .filter(Boolean);
    let markdown = blocksToMarkdown(markdownRoot);
    for (const name of attachments) {
      const label = `[Image: ${name}]`;
      if (!markdown.includes(label)) markdown = `${label}\n\n${markdown}`.trim();
    }
    if (!markdown && !attachments.length) return null;
    return {
      index: Number((turn.dataset.testid || turn.getAttribute("data-testid") || "").match(/(\d+)$/)?.[1]) || 0,
      turnId: turn.dataset.turnId,
      messageId: message.dataset.messageId || null,
      role,
      model: message.dataset.messageModelSlug || null,
      markdown,
      text: normalize(markdownRoot.innerText || markdownRoot.textContent || ""),
      attachments
    };
  }

  function inspect() {
    const turns = Array.from(document.querySelectorAll(TURN_SELECTOR));
    return { turns: turns.length, loaded: turns.filter((turn) => turn.querySelector(MESSAGE_SELECTOR)).length };
  }

  async function waitForMessage(turn) {
    const started = Date.now();
    while (!isCancelled() && Date.now() - started < WAIT_PER_TURN_MS) {
      const result = extractMessage(turn);
      if (result) return result;
      await sleep(80);
    }
    return null;
  }

  async function collectAll(loadAll) {
    const turns = Array.from(document.querySelectorAll(TURN_SELECTOR));
    if (!turns.length) throw new Error("No ChatGPT conversation was found on this page.");
    const scrollRoot = document.querySelector(SCROLL_SELECTOR);
    const originalTop = scrollRoot?.scrollTop || 0;
    const messages = new Map();

    const captureLoaded = () => {
      for (const turn of turns) {
        const message = extractMessage(turn);
        if (message) messages.set(message.turnId, message);
      }
    };
    captureLoaded();

    try {
      if (loadAll) {
        for (let index = 0; index < turns.length; index += 1) {
          if (isCancelled()) throw new Error("Export cancelled.");
          const turn = turns[index];
          if (!messages.has(turn.dataset.turnId)) {
            turn.scrollIntoView({ block: "center", behavior: "instant" });
            const message = await waitForMessage(turn);
            if (message) messages.set(message.turnId, message);
            captureLoaded();
          }
          sendProgress("Loading", messages.size, turns.length);
        }
      }
    } finally {
      if (scrollRoot) scrollRoot.scrollTo({ top: originalTop, behavior: "instant" });
    }

    return {
      messages: Array.from(messages.values()).sort((a, b) => a.index - b.index),
      total: turns.length,
      missing: turns.length - messages.size,
      source: "dom"
    };
  }

  function conversationIdFromUrl() {
    return location.pathname.match(CONVERSATION_ID_PATTERN)?.[1] || null;
  }

  async function fetchConversationMetadata(conversationId) {
    const path = `/backend-api/conversation/${encodeURIComponent(conversationId)}`;
    const url = new URL(path, location.origin).href;
    let response = await fetch(url, { credentials: "include" });
    if (response.ok) {
      return response.json();
    }
    if (![401, 403, 404].includes(response.status)) {
      throw new Error(`Conversation metadata request failed (${response.status}).`);
    }

    // Some ChatGPT deployments require the same short-lived bearer token used
    // by the web app. Unauthenticated requests may deliberately return 404.
    // Keep the token only in this function and never log or export it.
    const sessionUrl = new URL("/api/auth/session", location.origin).href;
    const sessionResponse = await fetch(sessionUrl, { credentials: "include" });
    if (!sessionResponse.ok) throw new Error("ChatGPT session metadata was unavailable.");
    const session = await sessionResponse.json();
    if (!session.accessToken) throw new Error("ChatGPT session did not provide an access token.");
    response = await fetch(url, {
      credentials: "include",
      headers: { Authorization: `Bearer ${session.accessToken}` }
    });
    if (!response.ok) throw new Error(`Conversation metadata request failed (${response.status}).`);
    return response.json();
  }

  function messageTextFromMetadata(message) {
    const content = message?.content;
    if (!content) return "";

    if (typeof content.text === "string") return normalize(content.text);
    if (!Array.isArray(content.parts)) return "";

    return normalize(content.parts.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      if (typeof part?.name === "string") return `[Attachment: ${part.name}]`;
      return "";
    }).filter(Boolean).join("\n\n"));
  }

  function isExportableMetadataMessage(message) {
    const role = message?.author?.role;
    if (role !== "user" && role !== "assistant") return false;
    if (!EXPORTABLE_METADATA_CONTENT_TYPES.has(message?.content?.content_type)) return false;

    const metadata = message.metadata || {};
    return !metadata.is_visually_hidden_from_conversation &&
      !metadata.is_hidden &&
      !metadata.hidden &&
      !metadata.is_redacted;
  }

  function selectedMetadataNodes(metadata) {
    const mapping = metadata?.mapping || {};
    const currentNode = metadata?.current_node;
    if (currentNode && mapping[currentNode]) {
      const path = [];
      const seen = new Set();
      let nodeId = currentNode;
      while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
        seen.add(nodeId);
        path.push([nodeId, mapping[nodeId]]);
        nodeId = mapping[nodeId].parent;
      }
      return path.reverse();
    }

    return Object.entries(mapping).sort(([, left], [, right]) => {
      const leftTime = left?.message?.create_time || 0;
      const rightTime = right?.message?.create_time || 0;
      return leftTime - rightTime;
    });
  }

  function applyTimestampsFromMetadata(result, metadata) {
    const byId = new Map();
    for (const [nodeId, node] of Object.entries(metadata?.mapping || {})) {
      const message = node?.message;
      const timestamp = toIsoTimestamp(message?.create_time);
      if (!timestamp) continue;
      byId.set(nodeId, timestamp);
      if (node?.id) byId.set(node.id, timestamp);
      if (message?.id) byId.set(message.id, timestamp);
    }

    let found = 0;
    for (const message of result.messages) {
      message.createdAt = byId.get(message.messageId) || byId.get(message.turnId) || null;
      if (message.createdAt) found += 1;
    }
    result.timestampStatus = found ? "available" : "unavailable";
  }

  async function collectFromMetadata(includeTimestamps) {
    const conversationId = conversationIdFromUrl();
    if (!conversationId) throw new Error("No conversation ID was found in the current URL.");

    const metadata = await fetchConversationMetadata(conversationId);
    const messages = [];

    for (const [nodeId, node] of selectedMetadataNodes(metadata)) {
      const raw = node?.message;
      if (!isExportableMetadataMessage(raw)) continue;

      const text = messageTextFromMetadata(raw);
      if (!text) continue;

      messages.push({
        index: messages.length + 1,
        turnId: nodeId,
        messageId: raw.id || node?.id || null,
        role: raw.author.role,
        model: raw.metadata?.model_slug || raw.metadata?.model || null,
        markdown: text,
        text,
        attachments: []
      });
    }

    if (!messages.length) throw new Error("Conversation metadata did not contain exportable messages.");

    const result = {
      messages,
      total: messages.length,
      missing: 0,
      source: "metadata"
    };
    if (includeTimestamps) applyTimestampsFromMetadata(result, metadata);
    return result;
  }

  async function addTimestamps(result) {
    for (const message of result.messages) message.createdAt = null;
    const conversationId = conversationIdFromUrl();
    if (!conversationId) return;

    try {
      const metadata = await fetchConversationMetadata(conversationId);
      applyTimestampsFromMetadata(result, metadata);
    } catch (_error) {
      // Timestamp enrichment is optional; the DOM export remains valid.
    }
  }

  function titleFromPage() {
    const raw = document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, "").trim();
    return raw && raw !== "ChatGPT" ? raw : "ChatGPT Conversation";
  }

  async function collect({ loadAll, includeTimestamps }) {
    let result;
    if (loadAll) {
      sendProgress("Reading metadata", 0, 1);
      try {
        result = await collectFromMetadata(includeTimestamps);
      } catch (_error) {
        result = await collectAll(true);
      }
    } else {
      result = await collectAll(false);
    }

    if (includeTimestamps && result.timestampStatus !== "available") {
      sendProgress("Adding dates", result.messages.length, result.total);
      await addTimestamps(result);
    }
    return result;
  }

  register({
    name: "ChatGPT",
    assistantLabel: "ChatGPT",
    title: titleFromPage,
    inspect,
    collect
  });
})();
