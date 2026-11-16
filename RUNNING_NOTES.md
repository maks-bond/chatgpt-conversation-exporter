# Running Notes

## Goal

Export all user and assistant messages from the currently open ChatGPT web
conversation, including very long conversations whose message bodies are
virtualized. Output should be downloadable and useful as context in another
chat. Processing must remain local.

## Current implementation

- Chrome Manifest V3 extension with a popup and statically declared content
  script.
- Supported origins: `https://chatgpt.com/*` and legacy
  `https://chat.openai.com/*`.
- Formats: Markdown, JSON, plain text.
- Optional timestamp enrichment is checked by default and never blocks text
  export.
- Actions: Blob-backed download, clipboard copy, console output.
- Permissions are limited to the active tab, clipboard writes, and downloads;
  host access is limited by the two ChatGPT content-script match patterns.
- Standalone console fallback in `standalone-console.js`.
- No build step and no third-party dependencies.

## Observed ChatGPT DOM (2026-06-19)

The supplied example contained 336 turn shells. Only turns close to the viewport
had message content. Off-screen turns looked like this:

```html
<section data-turn-id="..." data-testid="conversation-turn-3" data-turn="user"></section>
```

Hydrated turns use stable-looking semantic attributes:

```html
<section data-turn-id="..." data-testid="conversation-turn-1" data-turn="user">
  <div data-message-author-role="user" data-message-id="...">
    <div data-testid="collapsible-user-message-content">
      <div class="... whitespace-pre-wrap">User text</div>
    </div>
  </div>
</section>
```

Assistant messages use:

```html
<div data-message-author-role="assistant" data-message-id="..."
     data-message-model-slug="gpt-5-5">
  <div class="markdown prose ...">...</div>
</div>
```

The main scroll container is `[data-scroll-root]`. Turn shells remain present
while their contents are removed, so counting `<section>` elements gives the
expected total but scraping once only captures currently hydrated turns.

## Extraction strategy

1. Snapshot all `#thread section[data-turn-id][data-turn]` elements in DOM order.
2. Capture already hydrated `[data-message-author-role]` nodes.
3. For each uncaptured shell, call `scrollIntoView()` and wait up to 2.5 seconds
   for its message node to hydrate.
4. Capture every hydrated node after each scroll, keyed by `data-turn-id`.
5. Sort by the numeric `conversation-turn-N` suffix.
6. Restore the original `[data-scroll-root].scrollTop`.
7. Report the difference between turn shells and captured messages as missing.

Message content remains DOM-only. Timestamp enrichment optionally calls the
undocumented current-conversation metadata endpoint and joins `create_time` to
the visible branch using `data-message-id`, with `data-turn-id` as fallback. It
first tries cookie authentication. If required, it obtains a short-lived token
from `/api/auth/session`, keeps it only in a local function, and never logs,
persists, or exports it. The extension never reads the `client-bootstrap`
script, which can contain credentials and private account metadata.

## Timestamp strategy

- Extract a UUID from the current `/c/<conversation-id>` URL.
- Request `/backend-api/conversation/<conversation-id>` locally.
- Retry with the ephemeral session bearer token for `401`, `403`, or `404`;
  observed ChatGPT deployments return `404` for an otherwise valid but
  unauthenticated conversation request.
- Index `mapping[*].message.create_time` by mapping node ID, node ID, and
  message ID.
- Convert seconds, milliseconds, numeric strings, or date strings to ISO 8601.
- Preserve canonical UTC as `createdAt` in JSON and add `createdAtPacific`.
- Format Markdown/TXT dates in the IANA `America/Los_Angeles` zone as
  `YYYY-MM-DD HH:mm:ss PST/PDT (UTC-offset)`. `Intl.DateTimeFormat` applies the
  correct historical daylight-saving offset for each message.
- Use `null`/no label when a message does not match or metadata is unavailable.
- Never fail the main export because timestamp enrichment failed.

## Markdown conversion

The content script converts DOM nodes rather than flattening all content with
`innerText`. Supported structures include headings, paragraphs, ordered and
unordered lists, nested lists, blockquotes, fenced code, tables, links, images,
strong/emphasis/strikethrough, horizontal rules, and line breaks.

User text prefers `[data-testid="collapsible-user-message-content"]`; this covers
the supplied one-message example and excludes the adjacent Show more/Show less
button. Assistant text prefers `.markdown`.

Image URLs are deliberately excluded because observed URLs are signed,
account-bound, and expiring. Only image alt text/filenames are exported.

## Security incident note

The supplied full-page example included an access token, session token, email,
account IDs, and approximate location. It must never be committed as a fixture.
The user was advised to sign out everywhere to invalidate the exposed session.
Future fixtures must contain only sanitized turn markup.

## Claude support (2026-11-15)

Code layout: `shared.js` (Markdown conversion, timestamps, rendering, message
listener) is loaded before a per-site adapter, `chatgpt.js` or `claude.js`.
Adapters call `ChatExport.register({ name, assistantLabel, title, inspect,
collect })`. Adapters set `createdAt`; `shared.js` derives `createdAtPacific`.

Claude metadata path:

- Conversation ID from `/chat/<uuid>`, else the composer's
  `data-chat-input-conversation` attribute.
- Org IDs from the `lastActiveOrg` cookie, then `GET /api/organizations`.
- `GET /api/organizations/<org>/chat_conversations/<id>?tree=True&rendering_mode=messages&render_all_tools=true`.
- Walk `parent_message_uuid` back from `current_leaf_message_uuid` (selected
  branch); fall back to sorting by `index`.
- `sender` `human`/`assistant` maps to `user`/`assistant`; only `content[]`
  blocks with `type: "text"` are kept (legacy `text` field as fallback).

Claude DOM (observed 2026-11-15): rows are
`[data-testid="transcript-row"][data-index]` inside
`[data-autoscroll-container]`; off-screen rows are removed and replaced by
`transcript-spacer` divs, so there are no shells. The total comes from
`[role=article][aria-setsize]`. User text is `[data-testid="user-message"]`
(full text is present even when visually collapsed). Assistant text is every
`.standard-markdown` inside `[data-testid="assistant-message"]`; the
`TurnStatus` thinking summary sits outside it. `time[datetime]` exists only
where the message action bar has rendered. Buttons, SVGs, `aria-hidden`, and
`.sr-only` nodes are stripped before conversion.

Not yet verified against a live claude.ai session; only against a sanitized
fixture of the supplied markup.

## Files

- `manifest.json`: Manifest V3 metadata and permissions.
- `popup.html`, `popup.css`, `popup.js`: controls, progress, download/clipboard.
- `shared.js`: Markdown conversion, timestamp formatting, rendering, messaging.
- `chatgpt.js`: ChatGPT hydration, extraction, and metadata enrichment.
- `claude.js`: Claude conversation API export and virtualized-DOM fallback.
- `standalone-console.js`: dependency-free, simpler console fallback.
- `README.md`: installation, use, privacy, limitations.
- `RUNNING_NOTES.md`: handoff context and implementation decisions.

## Known risks and next debugging steps

- If ChatGPT replaces `data-turn`, `data-turn-id`, or
  `data-message-author-role`, update the selector constants at the top of
  `chatgpt.js` (or `claude.js` for Claude).
- If hydration becomes slower, increase `WAIT_PER_TURN_MS` or wait on a
  `MutationObserver` rather than polling every 80 ms.
- Extremely long conversations may take several minutes because every
  virtualized turn must enter the viewport. Cancel is cooperative between waits.
- The popup must remain open. A future version could move collection state and
  download orchestration to a service worker or an in-page progress panel.
- Rich interactive blocks need sanitized fixture examples before adding custom
  converters.
- The timestamp endpoint is undocumented. If it changes, preserve
  `createdAt: null` fallback behavior and do not replace it with bootstrap-token
  parsing.

## Verification checklist

- Parse `manifest.json` as JSON.
- Run `node --check` on JavaScript files.
- Load unpacked in Chrome, reload ChatGPT, and inspect the detected shell count.
- Export the supplied 336-turn conversation and confirm message count is 336.
- Spot-check user newlines, assistant lists, blockquotes, and code blocks.
- Confirm timestamped JSON and Markdown on a `/c/<UUID>` conversation, then
  confirm ordinary export still succeeds when the metadata request is blocked.
- Confirm cancellation and missing-turn warnings.
- Confirm no token-like strings or full-page fixture data exist in this folder.
