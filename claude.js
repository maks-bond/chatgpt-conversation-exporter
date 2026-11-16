(() => {
  "use strict";

  const { sleep, normalize, blocksToMarkdown, sendProgress, isCancelled, register } = globalThis.ChatExport;

  const ROW_SELECTOR = '[data-testid="transcript-row"][data-index]';
  const USER_SELECTOR = '[data-testid="user-message"]';
  const ASSISTANT_SELECTOR = '[data-testid="assistant-message"]';
  const ASSISTANT_TEXT_SELECTOR = ".standard-markdown";
  const SCROLL_SELECTOR = "[data-autoscroll-container]";
  const CONVERSATION_ATTRIBUTE = "data-chat-input-conversation";
  const CONVERSATION_ID_PATTERN = /\/chat\/([a-f0-9-]{36})(?:[/?#]|$)/i;
  // Message action bars, copy buttons, icons and screen-reader-only labels.
  const NOISE_SELECTOR = "button, svg, [aria-hidden='true'], .sr-only";
  const SETTLE_POLL_MS = 120;
  const SETTLE_MAX_MS = 3000;
  const SCROLL_STEP = 0.7;
  const MAX_TOP_ATTEMPTS = 20;

  // ---- Metadata (conversation API) ----

  function conversationId() {
    return location.pathname.match(CONVERSATION_ID_PATTERN)?.[1] ||
      document.querySelector(`[${CONVERSATION_ATTRIBUTE}]`)?.getAttribute(CONVERSATION_ATTRIBUTE) ||
      null;
  }

  async function getJson(path) {
    const response = await fetch(new URL(path, location.origin).href, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Claude request failed (${response.status}).`);
    return response.json();
  }

  async function organizationIds() {
    const ids = [];
    const lastActive = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/)?.[1];
    if (lastActive) ids.push(decodeURIComponent(lastActive));
    try {
      const organizations = await getJson("/api/organizations");
      for (const organization of Array.isArray(organizations) ? organizations : []) {
        if (organization?.uuid && !ids.includes(organization.uuid)) ids.push(organization.uuid);
      }
    } catch (_error) {
      // The cookie value alone may still be enough.
    }
    return ids;
  }

  async function fetchConversation(id) {
    const organizations = await organizationIds();
    if (!organizations.length) throw new Error("No Claude organization was found for this session.");
    let lastError;
    for (const organization of organizations) {
      try {
        return await getJson(
          `/api/organizations/${encodeURIComponent(organization)}/chat_conversations/` +
          `${encodeURIComponent(id)}?tree=True&rendering_mode=messages&render_all_tools=true`
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  // Follow the branch the user is viewing: walk parents from the current leaf.
  function selectedBranch(conversation) {
    const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
    const byId = new Map(messages.map((message) => [message.uuid, message]));
    const leaf = conversation?.current_leaf_message_uuid;
    if (leaf && byId.has(leaf)) {
      const path = [];
      const seen = new Set();
      let id = leaf;
      while (id && byId.has(id) && !seen.has(id)) {
        seen.add(id);
        path.push(byId.get(id));
        id = byId.get(id).parent_message_uuid;
      }
      return path.reverse();
    }
    return [...messages].sort((left, right) =>
      (left.index ?? 0) - (right.index ?? 0) ||
      String(left.created_at || "").localeCompare(String(right.created_at || ""))
    );
  }

  // Only visible text blocks; thinking, tool calls and tool results are skipped.
  function messageText(message) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const texts = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text);
    if (texts.length) return normalize(texts.join("\n\n"));
    return typeof message?.text === "string" ? normalize(message.text) : "";
  }

  function attachmentNames(message) {
    const files = [...(message?.attachments || []), ...(message?.files || []), ...(message?.files_v2 || [])];
    return [...new Set(files.map((file) => file?.file_name || file?.name).filter(Boolean))];
  }

  async function collectFromMetadata() {
    const id = conversationId();
    if (!id) throw new Error("No Claude conversation ID was found on this page.");
    const conversation = await fetchConversation(id);
    const messages = [];

    for (const raw of selectedBranch(conversation)) {
      const role = raw?.sender === "human" ? "user" : raw?.sender === "assistant" ? "assistant" : null;
      if (!role) continue;
      const attachments = attachmentNames(raw);
      const body = messageText(raw);
      const markdown = [...attachments.map((name) => `[Attachment: ${name}]`), body].filter(Boolean).join("\n\n");
      if (!markdown) continue;

      messages.push({
        index: messages.length + 1,
        turnId: raw.uuid,
        messageId: raw.uuid,
        role,
        model: role === "assistant" ? raw.model || conversation.model || null : null,
        markdown,
        text: markdown,
        attachments,
        createdAt: raw.created_at || null
      });
    }

    if (!messages.length) throw new Error("Claude conversation data did not contain exportable messages.");
    return { messages, total: messages.length, missing: 0, source: "metadata" };
  }

  // ---- DOM (virtualized transcript) ----

  function scrollRoot() {
    const container = document.querySelector(SCROLL_SELECTOR);
    if (container && container.scrollHeight > container.clientHeight + 4) return container;
    return document.scrollingElement || document.documentElement;
  }

  function renderedRows() {
    return Array.from(document.querySelectorAll(ROW_SELECTOR));
  }

  // Rows outside the viewport are removed and replaced by spacers, so the
  // total comes from the aria-setsize the transcript advertises.
  function totalRows() {
    const sizes = Array.from(document.querySelectorAll("[role='article'][aria-setsize]"), (article) =>
      Number(article.getAttribute("aria-setsize")) || 0
    );
    return Math.max(renderedRows().length, ...sizes);
  }

  function toMarkdown(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll(NOISE_SELECTOR).forEach((node) => node.remove());
    return blocksToMarkdown(clone);
  }

  function extractRow(row) {
    const user = row.querySelector(USER_SELECTOR);
    const assistant = row.querySelector(ASSISTANT_SELECTOR);
    let role;
    let markdown;
    let attachments = [];

    if (user) {
      role = "user";
      attachments = Array.from(row.querySelectorAll("img[alt]"), (image) => image.getAttribute("alt")).filter(Boolean);
      markdown = [...attachments.map((name) => `[Image: ${name}]`), toMarkdown(user)].filter(Boolean).join("\n\n");
    } else if (assistant) {
      role = "assistant";
      const roots = assistant.querySelectorAll(ASSISTANT_TEXT_SELECTOR);
      markdown = normalize(Array.from(roots, toMarkdown).filter(Boolean).join("\n\n"));
    } else {
      return null;
    }
    if (!markdown) return null;

    const turnKey = row.querySelector("[data-turn-key]")?.getAttribute("data-turn-key") || null;
    return {
      index: Number(row.dataset.index),
      turnId: turnKey,
      messageId: turnKey,
      role,
      model: null,
      markdown,
      text: markdown,
      attachments,
      // Only rows whose action bar has rendered carry a <time>.
      createdAt: row.querySelector("time[datetime]")?.getAttribute("datetime") || null
    };
  }

  // Wait until the set of mounted rows and the scroll height stop changing.
  async function settle() {
    const started = Date.now();
    let last = "";
    let stable = 0;
    while (Date.now() - started < SETTLE_MAX_MS) {
      await sleep(SETTLE_POLL_MS);
      const root = scrollRoot();
      const signature = `${renderedRows().map((row) => row.dataset.index).join(",")}|${root.scrollHeight}`;
      if (signature === last) {
        stable += 1;
        if (stable >= 2) return;
      } else {
        stable = 0;
        last = signature;
      }
    }
  }

  async function collectFromDom(loadAll) {
    if (!renderedRows().length) throw new Error("No Claude conversation was found on this page.");
    const root = scrollRoot();
    const originalTop = root.scrollTop;
    const captured = new Map();

    const capture = () => {
      for (const row of renderedRows()) {
        const message = extractRow(row);
        if (message) captured.set(message.index, message);
      }
    };
    capture();

    try {
      if (loadAll) {
        // Older messages may be fetched (and prepended) on reaching the top, which
        // shifts row indices. Keep returning to the top until nothing new loads,
        // then sweep downward once with stable indices.
        let lastTotal = -1;
        for (let attempt = 0; attempt < MAX_TOP_ATTEMPTS; attempt += 1) {
          if (isCancelled()) throw new Error("Export cancelled.");
          root.scrollTop = 0;
          await settle();
          const total = totalRows();
          const firstIndex = Math.min(...renderedRows().map((row) => Number(row.dataset.index)));
          sendProgress("Loading earlier messages", 0, total);
          if (firstIndex === 0 && total === lastTotal) break;
          lastTotal = total;
        }

        captured.clear();
        let stuck = 0;
        while (true) {
          if (isCancelled()) throw new Error("Export cancelled.");
          capture();
          const total = totalRows();
          sendProgress("Loading", captured.size, total);
          if (captured.size >= total) break;
          if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) break;
          const before = root.scrollTop;
          root.scrollTop = before + root.clientHeight * SCROLL_STEP;
          await settle();
          if (root.scrollTop <= before) {
            stuck += 1;
            if (stuck >= 3) break;
          } else {
            stuck = 0;
          }
        }
        capture();
      }
    } finally {
      root.scrollTop = originalTop;
    }

    const total = totalRows();
    return {
      messages: Array.from(captured.values()).sort((a, b) => a.index - b.index),
      total,
      missing: Math.max(0, total - captured.size),
      source: "dom"
    };
  }

  function inspect() {
    return { turns: totalRows(), loaded: renderedRows().length };
  }

  function titleFromPage() {
    const raw = document.title.replace(/\s*[-|–—]\s*Claude\s*$/i, "").trim();
    return raw && raw !== "Claude" ? raw : "Claude Conversation";
  }

  async function collect({ loadAll }) {
    if (loadAll) {
      sendProgress("Reading conversation", 0, 1);
      try {
        return await collectFromMetadata();
      } catch (_error) {
        // Fall back to scrolling the transcript.
      }
    }
    return collectFromDom(loadAll);
  }

  register({
    name: "Claude",
    assistantLabel: "Claude",
    title: titleFromPage,
    inspect,
    collect
  });
})();
