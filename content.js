(() => {
  "use strict";

  const TURN_SELECTOR = "#thread section[data-turn-id][data-turn]";
  const MESSAGE_SELECTOR = "[data-message-author-role]";
  const SCROLL_SELECTOR = "[data-scroll-root]";
  const WAIT_PER_TURN_MS = 2500;
  const CONVERSATION_ID_PATTERN = /\/c\/([a-f0-9-]{36})(?:[/?#]|$)/i;
  const PACIFIC_TIME_ZONE = "America/Los_Angeles";
  const EXPORTABLE_METADATA_CONTENT_TYPES = new Set(["text", "multimodal_text", "code"]);
  let cancelled = false;
  let running = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalize(text) {
    return text
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function inlineMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    const content = Array.from(node.childNodes, inlineMarkdown).join("");
    if (tag === "br") return "\n";
    if (tag === "strong" || tag === "b") return `**${content}**`;
    if (tag === "em" || tag === "i") return `_${content}_`;
    if (tag === "del" || tag === "s") return `~~${content}~~`;
    if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") return `\`${content}\``;
    if (tag === "a") {
      const href = node.getAttribute("href");
      return href ? `[${content || href}](${href})` : content;
    }
    if (tag === "img") return `[Image: ${node.getAttribute("alt") || "attachment"}]`;
    return content;
  }

  function listToMarkdown(list, depth = 0) {
    const ordered = list.tagName.toLowerCase() === "ol";
    const start = Number(list.getAttribute("start")) || 1;
    return Array.from(list.children)
      .filter((child) => child.tagName?.toLowerCase() === "li")
      .map((item, index) => {
        const nested = Array.from(item.children).filter((child) => /^(ul|ol)$/i.test(child.tagName));
        const clone = item.cloneNode(true);
        clone.querySelectorAll(":scope > ul, :scope > ol").forEach((child) => child.remove());
        const marker = ordered ? `${start + index}.` : "-";
        let line = `${"  ".repeat(depth)}${marker} ${normalize(blocksToMarkdown(clone))}`;
        for (const child of nested) line += `\n${listToMarkdown(child, depth + 1)}`;
        return line;
      })
      .join("\n");
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
      Array.from(row.querySelectorAll(":scope > th, :scope > td")).map((cell) =>
        normalize(inlineMarkdown(cell)).replace(/\|/g, "\\|").replace(/\n/g, " ")
      )
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")];
    const output = [pad(rows[0]), Array(width).fill("---"), ...rows.slice(1).map(pad)];
    return output.map((row) => `| ${row.join(" | ")} |`).join("\n");
  }

  function blockToMarkdown(element) {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${normalize(inlineMarkdown(element))}`;
    if (tag === "p") return normalize(inlineMarkdown(element));
    if (tag === "ul" || tag === "ol") return listToMarkdown(element);
    if (tag === "blockquote") {
      return normalize(blocksToMarkdown(element)).split("\n").map((line) => `> ${line}`).join("\n");
    }
    if (tag === "pre") {
      const code = element.querySelector("code") || element;
      const language = Array.from(code.classList).find((name) => name.startsWith("language-"))?.slice(9) || "";
      return `\`\`\`${language}\n${(code.textContent || "").replace(/\n$/, "")}\n\`\`\``;
    }
    if (tag === "table") return tableToMarkdown(element);
    if (tag === "hr") return "---";
    if (tag === "img") return inlineMarkdown(element);
    return blocksToMarkdown(element);
  }

  function blocksToMarkdown(root) {
    const parts = [];
    for (const child of root.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.nodeValue?.trim()) parts.push(child.nodeValue.trim());
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        parts.push(blockToMarkdown(child));
      }
    }
    return normalize(parts.filter(Boolean).join("\n\n"));
  }

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
    while (!cancelled && Date.now() - started < WAIT_PER_TURN_MS) {
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
    cancelled = false;

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
          if (cancelled) throw new Error("Export cancelled.");
          const turn = turns[index];
          if (!messages.has(turn.dataset.turnId)) {
            turn.scrollIntoView({ block: "center", behavior: "instant" });
            const message = await waitForMessage(turn);
            if (message) messages.set(message.turnId, message);
            captureLoaded();
          }
          chrome.runtime.sendMessage({
            type: "chat-export-progress",
            phase: "Loading",
            completed: messages.size,
            total: turns.length
          }).catch(() => {});
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
    result.timestamps = 0;
    result.timestampStatus = "unavailable";

    const byId = new Map();
    for (const [nodeId, node] of Object.entries(metadata?.mapping || {})) {
      const message = node?.message;
      const timestamp = toIsoTimestamp(message?.create_time);
      if (!timestamp) continue;
      byId.set(nodeId, timestamp);
      if (node?.id) byId.set(node.id, timestamp);
      if (message?.id) byId.set(message.id, timestamp);
    }

    for (const message of result.messages) {
      message.createdAt = byId.get(message.messageId) || byId.get(message.turnId) || null;
      message.createdAtPacific = message.createdAt ? formatPacificTimestamp(message.createdAt) : null;
      if (message.createdAtPacific) result.timestamps += 1;
    }
    result.timestampStatus = result.timestamps ? "available" : "unavailable";
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

  function toIsoTimestamp(value) {
    if (value === null || value === undefined || value === "") return null;
    let date;
    if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value))) {
      const numeric = Number(value);
      date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    } else {
      date = new Date(value);
    }
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function formatPacificTimestamp(isoTimestamp) {
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) return null;
    const dateTimeParts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: PACIFIC_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }).formatToParts(date).map((part) => [part.type, part.value])
    );
    const abbreviation = new Intl.DateTimeFormat("en-US", {
      timeZone: PACIFIC_TIME_ZONE,
      timeZoneName: "short"
    }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value || "PT";
    const offset = new Intl.DateTimeFormat("en-US", {
      timeZone: PACIFIC_TIME_ZONE,
      timeZoneName: "longOffset"
    }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value
      .replace("GMT", "UTC") || "UTC";
    return `${dateTimeParts.year}-${dateTimeParts.month}-${dateTimeParts.day} ` +
      `${dateTimeParts.hour}:${dateTimeParts.minute}:${dateTimeParts.second} ` +
      `${abbreviation} (${offset})`;
  }

  async function addTimestamps(result) {
    result.timestamps = 0;
    result.timestampStatus = "unavailable";
    for (const message of result.messages) {
      message.createdAt = null;
      message.createdAtPacific = null;
    }
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

  function safeFilename(title) {
    return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "chatgpt-conversation";
  }

  function render(result, format) {
    const title = titleFromPage();
    const exportedAt = new Date().toISOString();
    if (format === "json") {
      return JSON.stringify({
        title,
        url: location.href,
        exportedAt,
        source: result.source || "unknown",
        missingTurns: result.missing,
        messages: result.messages
      }, null, 2);
    }
    if (format === "text") {
      return result.messages.map((message) => {
        const timestamp = message.createdAtPacific ? ` [${message.createdAtPacific}]` : "";
        return `${message.role === "user" ? "USER" : "ASSISTANT"}${timestamp}:\n${message.text || message.markdown}`;
      }).join("\n\n---\n\n");
    }
    const header = `# ${title}\n\nExported: ${exportedAt}\n\nSource: ${location.href}`;
    const warning = result.missing ? `\n\n> Warning: ${result.missing} turn(s) could not be loaded.` : "";
    const body = result.messages.map((message) => {
      const timestamp = message.createdAtPacific ? `\n\n*${message.createdAtPacific}*` : "";
      return `## ${message.role === "user" ? "You" : "ChatGPT"}${timestamp}\n\n${message.markdown}`;
    }).join("\n\n---\n\n");
    return `${header}${warning}\n\n${body}\n`;
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.type === "chat-export-inspect") {
      sendResponse(inspect());
      return false;
    }
    if (request?.type === "chat-export-cancel") {
      cancelled = true;
      sendResponse({ ok: true });
      return false;
    }
    if (request?.type !== "chat-export-run") return false;
    if (running) {
      sendResponse({ ok: false, error: "An export is already running in this tab." });
      return false;
    }

    running = true;
    (async () => {
      try {
        let result;
        if (request.loadAll) {
          chrome.runtime.sendMessage({
            type: "chat-export-progress",
            phase: "Reading metadata",
            completed: 0,
            total: 1
          }).catch(() => {});
          try {
            result = await collectFromMetadata(request.includeTimestamps);
          } catch (_error) {
            result = await collectAll(true);
          }
        } else {
          result = await collectAll(false);
        }

        if (request.includeTimestamps && result.timestampStatus !== "available") {
          chrome.runtime.sendMessage({
            type: "chat-export-progress",
            phase: "Adding dates",
            completed: result.messages.length,
            total: result.total
          }).catch(() => {});
          await addTimestamps(result);
        }
        const content = render(result, request.format);
        if (request.action === "console") {
          console.group(`ChatGPT export: ${titleFromPage()}`);
          console.log(content);
          console.groupEnd();
        }
        const extensions = { markdown: "md", json: "json", text: "txt" };
        const mimes = { markdown: "text/markdown;charset=utf-8", json: "application/json;charset=utf-8", text: "text/plain;charset=utf-8" };
        sendResponse({
          ok: true,
          content,
          count: result.messages.length,
          missing: result.missing,
          timestampsRequested: Boolean(request.includeTimestamps),
          timestamps: result.timestamps || 0,
          source: result.source || "unknown",
          characters: content.length,
          filename: `${safeFilename(titleFromPage())}.${extensions[request.format] || "txt"}`,
          mime: mimes[request.format] || mimes.text
        });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      } finally {
        running = false;
      }
    })();
    return true;
  });
})();
