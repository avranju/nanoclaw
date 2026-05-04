# Telegram Channel

## Intent

Add Telegram as a chat channel. The user has only Telegram configured (no WhatsApp). Supports text messages, photos, documents, stickers, inline keyboard buttons (for approvals/questions), and bot pool for agent teams.

## Files

### `src/channels/telegram.ts` — NEW FILE

Full Telegram channel adapter using the `grammy` library. Key features:

- **Bot setup**: Uses `TELEGRAM_BOT_TOKEN` from env. Registers `/chatid` and `/ping` commands.
- **Text messages**: Handles `@botusername` mentions as trigger. Converts to `@ASSISTANT_NAME` format.
- **Photo handling**: Downloads photos from Telegram API, saves to `data/telegram-incoming/`, passes as attachments.
- **Document handling**: Downloads documents, saves to `data/telegram-incoming/`, passes as file attachments.
- **Other media**: Photos, videos, voice, audio, stickers, location, contacts — handled with placeholders.
- **Inline keyboard buttons**: Routes `callback_query:data` events with `ncq:<questionId>:<value>` format back to the action handler.
- **Bot pool**: Supports `TELEGRAM_BOT_POOL` env var (comma-separated tokens) for agent teams. Each sender gets a dedicated pool bot with a unique name.
- **Message delivery**: Sends messages as Markdown (falls back to plain text on parse error). Splits messages >4096 chars.
- **Typing indicator**: Sends `typing` chat action before agent starts working.
- **Approval cards**: Renders `ask_question` content type as inline keyboard buttons.

Key interfaces:
- `sendWithMarkdown(api, chatId, text)` — Sends with Markdown, falls back to plain text
- `initBotPool(tokens)` — Initializes send-only Api instances for bot pool
- `sendPoolMessage(chatId, text, sender, groupFolder)` — Sends via pool bot
- `createAdapter()` — Creates the ChannelAdapter instance
- `registerChannelAdapter('telegram', { factory: createAdapter })` — Registers the adapter

### `.gitignore` — MODIFY

Add Telegram-related entries. The diff shows changes to `.gitignore` for Telegram.

### `src/container-runner.ts` — MODIFY

Add Telegram SSH key mounting. When the Telegram channel is configured, mount SSH keys into the container for Telegram document download access.

### `src/modules/self-mod/apply.ts` — MODIFY

Add Telegram approval card rendering. When an approval action is approved via Telegram, render the result as an inline message.

## How to apply

1. Create `src/channels/telegram.ts` with the full file content (557 lines)
2. Ensure `.gitignore` includes Telegram-related entries
3. Update `src/container-runner.ts` to mount SSH keys when Telegram is configured
4. Update `src/modules/self-mod/apply.ts` to render Telegram approval cards

## Notes

- The Telegram channel replaces WhatsApp entirely (user has no WhatsApp configured)
- The `grammy` library is used (already in `package.json` dependencies)
- Chat IDs are stored as `tg:<numeric_id>` in the database
- Bot pool feature allows multiple Telegram bots for load balancing across agent teams
- Inline keyboard buttons use the `ncq:` prefix format, matching the existing question/answer system
