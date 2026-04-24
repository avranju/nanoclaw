import fs from 'fs';
import path from 'path';

import { Api, Bot } from 'grammy';

import {
  ASSISTANT_NAME,
  TELEGRAM_BOT_POOL,
  TRIGGER_PATTERN,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

async function sendWithMarkdown(
  api: Api,
  chatId: string | number,
  text: string,
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err: any) {
    if (err?.error_code === 400 || err?.statusCode === 400) {
      log.debug('Markdown parse failed, sending as plain text', {
        err: err.message,
      });
      await api.sendMessage(chatId, text);
    } else {
      throw err;
    }
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      log.info('Pool bot initialized', {
        username: me.username,
        id: me.id,
        poolSize: poolApis.length,
      });
    } catch (err) {
      log.error('Failed to initialize pool bot', { err });
    }
  }
  if (poolApis.length > 0) {
    log.info('Telegram bot pool ready', { count: poolApis.length });
  }
}

export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    log.warn('No pool bots available, falling back to main bot');
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      log.info('Assigned and renamed pool bot', {
        sender,
        groupFolder,
        poolIndex: idx,
      });
    } catch (err) {
      log.warn('Failed to rename pool bot (sending anyway)', { sender, err });
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendWithMarkdown(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendWithMarkdown(api, numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    log.info('Pool message sent', {
      chatId,
      sender,
      poolIndex: idx,
      length: text.length,
    });
  } catch (err) {
    log.error('Failed to send pool message', { chatId, sender, err });
  }
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as
    | Record<string, unknown>
    | string
    | undefined;
  if (typeof content === 'string') return content;
  if (
    content &&
    typeof content === 'object' &&
    typeof content.text === 'string'
  ) {
    return content.text;
  }
  return null;
}

function createAdapter(): ChannelAdapter {
  let bot: Bot | null = null;

  const adapter: ChannelAdapter = {
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      const token =
        process.env.TELEGRAM_BOT_TOKEN ||
        readEnvFile(['TELEGRAM_BOT_TOKEN']).TELEGRAM_BOT_TOKEN;
      if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

      bot = new Bot(token);

      bot.command('chatid', (ctx) => {
        const chatId = ctx.chat.id;
        const chatType = ctx.chat.type;
        const chatName =
          chatType === 'private'
            ? ctx.from?.first_name || 'Private'
            : (ctx.chat as any).title || 'Unknown';
        ctx.reply(
          `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
          {
            parse_mode: 'Markdown',
          },
        );
      });

      bot.command('ping', (ctx) => {
        ctx.reply(`${ASSISTANT_NAME} is online.`);
      });

      bot.on('message:text', async (ctx) => {
        if (ctx.message.text.startsWith('/')) return;

        const chatJid = `tg:${ctx.chat.id}`;
        let content = ctx.message.text;
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id.toString() ||
          'Unknown';
        const senderId = ctx.from?.id.toString() || '';
        const msgId = ctx.message.message_id.toString();
        const isGroup = ctx.chat.type !== 'private';
        const chatName = isGroup
          ? (ctx.chat as any).title || chatJid
          : senderName;

        // Translate Telegram @mentions into trigger format
        const botUsername = ctx.me?.username?.toLowerCase();
        let isMention = false;
        if (botUsername) {
          const entities = ctx.message.entities || [];
          isMention = entities.some((entity) => {
            if (entity.type === 'mention') {
              const mentionText = content
                .substring(entity.offset, entity.offset + entity.length)
                .toLowerCase();
              return mentionText === `@${botUsername}`;
            }
            return false;
          });
          if (isMention && !TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }

        config.onMetadata(chatJid, chatName, isGroup);

        await config.onInbound(chatJid, null, {
          id: msgId,
          kind: 'chat',
          timestamp,
          content: {
            text: content,
            sender: senderName,
            senderId: `tg:${senderId}`,
          },
          isMention,
        });

        log.info('Telegram message received', {
          chatJid,
          chatName,
          sender: senderName,
        });
      });

      const storeNonText = async (ctx: any, placeholder: string) => {
        const chatJid = `tg:${ctx.chat.id}`;
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';
        const senderId = ctx.from?.id?.toString() || '';
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
        const isGroup = ctx.chat.type !== 'private';
        const chatName = isGroup
          ? (ctx.chat as any).title || chatJid
          : senderName;

        config.onMetadata(chatJid, chatName, isGroup);
        await config.onInbound(chatJid, null, {
          id: ctx.message.message_id.toString(),
          kind: 'chat',
          timestamp,
          content: {
            text: `${placeholder}${caption}`,
            sender: senderName,
            senderId: `tg:${senderId}`,
          },
        });
      };

      bot.on('message:photo', async (ctx) => {
        const chatJid = `tg:${ctx.chat.id}`;
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';
        const senderId = ctx.from?.id?.toString() || '';
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
        const isGroup = ctx.chat.type !== 'private';
        const chatName = isGroup
          ? (ctx.chat as any).title || chatJid
          : senderName;

        try {
          const photos = ctx.message.photo;
          const photo = photos[photos.length - 1];
          const file = await ctx.getFile();
          const filePath = file.file_path!;
          const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
          const response = await fetch(downloadUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());

          const ext = filePath.split('.').pop() || 'jpg';
          const filename = `photo_${ctx.message.date}_${photo.file_id.slice(-8)}.${ext}`;

          // Save to the group workspace. We don't know the group folder here, so save
          // to a shared incoming dir in the data directory.
          const incomingDir = path.join(
            process.cwd(),
            'data',
            'telegram-incoming',
          );
          fs.mkdirSync(incomingDir, { recursive: true });
          fs.writeFileSync(path.join(incomingDir, filename), buffer);

          config.onMetadata(chatJid, chatName, isGroup);
          await config.onInbound(chatJid, null, {
            id: ctx.message.message_id.toString(),
            kind: 'chat',
            timestamp,
            content: {
              text: ctx.message.caption || '',
              sender: senderName,
              senderId: `tg:${senderId}`,
              attachments: [
                { type: 'image', name: filename, localPath: `telegram-incoming/${filename}` },
              ],
            },
          });
          log.info('Telegram photo saved', { chatJid, filename });
        } catch (err) {
          log.error('Failed to download Telegram photo, using placeholder', {
            err,
          });
          await storeNonText(ctx, '[Photo]');
        }
      });

      bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
      bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
      bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));

      bot.on('message:document', async (ctx) => {
        const chatJid = `tg:${ctx.chat.id}`;
        const doc = ctx.message.document;
        const originalName = doc?.file_name || 'file';
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';
        const senderId = ctx.from?.id?.toString() || '';
        const isGroup = ctx.chat.type !== 'private';
        const chatName = isGroup
          ? (ctx.chat as any).title || chatJid
          : senderName;

        try {
          const file = await ctx.getFile();
          const filePath = file.file_path!;
          const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
          const response = await fetch(downloadUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());

          const ext = originalName.includes('.')
            ? originalName.split('.').pop()!
            : filePath.split('.').pop() || 'bin';
          const baseName = originalName
            .replace(/\.[^.]+$/, '')
            .replace(/[^a-zA-Z0-9_-]/g, '_');
          const filename = `${baseName}_${ctx.message.date}.${ext}`;
          const incomingDir = path.join(
            process.cwd(),
            'data',
            'telegram-incoming',
          );
          fs.mkdirSync(incomingDir, { recursive: true });
          fs.writeFileSync(path.join(incomingDir, filename), buffer);

          config.onMetadata(chatJid, chatName, isGroup);
          await config.onInbound(chatJid, null, {
            id: ctx.message.message_id.toString(),
            kind: 'chat',
            timestamp,
            content: {
              text: ctx.message.caption || '',
              sender: senderName,
              senderId: `tg:${senderId}`,
              attachments: [
                { type: 'file', name: originalName, localPath: `telegram-incoming/${filename}` },
              ],
            },
          });
          log.info('Telegram document saved', { chatJid, filename });
        } catch (err) {
          log.error('Failed to download Telegram document, using placeholder', {
            err,
          });
          await storeNonText(ctx, `[Document: ${originalName}]`);
        }
      });

      bot.on('message:sticker', (ctx) => {
        const emoji = ctx.message.sticker?.emoji || '';
        storeNonText(ctx, `[Sticker ${emoji}]`);
      });
      bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
      bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

      bot.catch((err) => {
        log.error('Telegram bot error', { err: err.message });
      });

      // Initialize pool bots if configured
      if (TELEGRAM_BOT_POOL.length > 0) {
        await initBotPool(TELEGRAM_BOT_POOL);
      }

      await new Promise<void>((resolve) => {
        bot!.start({
          onStart: (botInfo) => {
            log.info('Telegram bot connected', {
              username: botInfo.username,
              id: botInfo.id,
            });
            console.log(`\n  Telegram bot: @${botInfo.username}`);
            console.log(
              `  Send /chatid to the bot to get a chat's registration ID\n`,
            );
            resolve();
          },
        });
      });
    },

    async teardown(): Promise<void> {
      if (bot) {
        bot.stop();
        bot = null;
        log.info('Telegram bot stopped');
      }
    },

    isConnected(): boolean {
      return bot !== null;
    },

    async deliver(
      platformId: string,
      _threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      if (!bot) {
        log.warn('Telegram bot not initialized');
        return undefined;
      }

      const text = extractText(message);
      if (text === null) return undefined;

      const numericId = platformId.replace(/^tg:/, '');
      const MAX_LENGTH = 4096;
      try {
        if (text.length <= MAX_LENGTH) {
          await sendWithMarkdown(bot.api, numericId, text);
        } else {
          for (let i = 0; i < text.length; i += MAX_LENGTH) {
            await sendWithMarkdown(
              bot.api,
              numericId,
              text.slice(i, i + MAX_LENGTH),
            );
          }
        }
        log.info('Telegram message sent', { platformId, length: text.length });
      } catch (err) {
        log.error('Failed to send Telegram message', { platformId, err });
      }
      return undefined;
    },

    async setTyping(
      platformId: string,
      _threadId: string | null,
    ): Promise<void> {
      if (!bot) return;
      const numericId = platformId.replace(/^tg:/, '');
      try {
        await bot.api.sendChatAction(numericId, 'typing');
      } catch (err) {
        log.debug('Failed to send Telegram typing indicator', {
          platformId,
          err,
        });
      }
    },
  };

  return adapter;
}

registerChannelAdapter('telegram', { factory: createAdapter });
