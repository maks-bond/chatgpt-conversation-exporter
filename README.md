# ChatGPT Conversation Exporter

A local-only Chrome extension that exports the conversation currently open on
`chatgpt.com`. It supports Markdown, JSON, plain text, per-message timestamps,
clipboard output, and DevTools console output.

## Install

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `chatgpt-conversation-exporter` directory.
5. Reload any ChatGPT tab that was already open.

## Use

1. Open the ChatGPT conversation you want to export.
2. Click the extension toolbar icon.
3. Keep **Load every virtualized message** checked for a complete export.
4. Keep **Include message dates when available** checked to enrich messages
   with their server creation times.
5. Select Markdown, JSON, or plain text.
6. Click **Download**. This is the recommended action for large conversations.

The page scrolls while the export runs because ChatGPT virtualizes old message
bodies. Keep the tab open and do not manually scroll until it finishes. The
extension restores the original scroll position afterward.

**Copy** uses the clipboard and is convenient for smaller conversations.
**Console** writes the resulting string to the DevTools console for the ChatGPT
tab. Chrome may display content-script logs under an extension execution
context.

## Standalone fallback

If you do not want to install the extension, open DevTools on the conversation,
open the Console, paste the complete contents of `standalone-console.js`, and
press Enter. It downloads a simpler Markdown transcript. The extension provides
better Markdown preservation and diagnostics.

## What is exported

- User and assistant message text
- Headings, lists, quotes, code blocks, tables, links, and inline formatting in
  assistant responses
- Turn IDs, message IDs, model names, and attachment labels in JSON
- Message creation times formatted in `America/Los_Angeles`, including the
  historical `PST`/`PDT` abbreviation and explicit UTC offset
- Image filenames/alt text, but not private or expiring image URLs

It does not export account data, bootstrap scripts, cookies, access tokens,
message action buttons, the composer, or sidebar content.

Timestamp enrichment makes a local request to the current conversation's
ChatGPT metadata endpoint. If that endpoint requires authentication, the
extension obtains a short-lived session token in memory for that request only.
It is never logged, persisted, or included in the export. Timestamp failure does
not prevent the conversation text from exporting.

Markdown and text output use a timestamp such as
`2026-06-19 10:34:22 PDT (UTC-07:00)`. Daylight-saving rules are applied for
each message's date. JSON retains the canonical UTC `createdAt` value and adds
the display-ready `createdAtPacific` value. Unavailable values remain `null`.

## Limitations

- ChatGPT's DOM is not a public API and may change.
- Message timestamps rely on an undocumented ChatGPT metadata endpoint and may
  stop working independently of text export.
- Branch alternatives that are not selected in the visible conversation are
  not exported.
- Generated widgets, canvases, and rich app results may degrade to visible text.
- A turn that fails to hydrate is reported as missing; the extension does not
  silently label an incomplete export as complete.
- Closing the popup can interrupt the popup-side download workflow. Leave it
  open until the progress finishes.

## Privacy and security

All parsing occurs locally in the current tab. There are no analytics, network
requests, or external services.

Do not share full ChatGPT page source. It can contain your email address, account
identifiers, session tokens, access tokens, location data, and private chat text.
If page source containing tokens was shared, sign out of ChatGPT on all devices
to invalidate the session before continuing.

## Troubleshooting

- **No conversation found:** Make sure a conversation, rather than the new-chat
  page, is open.
- **Reload after installing:** A statically declared content script is added to
  tabs only after they load.
- **Missing turns:** Run the export again without interacting with the page. If
  the same turn fails, capture only that turn's sanitized `<section>` element.
- **Selector changes:** See `RUNNING_NOTES.md` for the selector strategy.

Chrome extension structure follows the official Manifest V3 content-script and
downloads API documentation:

- https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
- https://developer.chrome.com/docs/extensions/reference/api/downloads
