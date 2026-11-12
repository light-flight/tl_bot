import { Bot, type Context } from "grammy"
import { buildDescription, formatSuccessReply, messageLinkTitle, telegramMessageLink } from "./description.js"
import type { LinearGateway } from "./linear.js"
import { parseMessage, type TextEntity } from "./parse-message.js"

const DEDUPE_TTL_MS = 10 * 60 * 1000

type Seen = {
  begin: (chatId: number, messageId: number) => boolean
  forget: (chatId: number, messageId: number) => void
}

export function createBot(deps: { token: string; linear: LinearGateway }): Bot {
  const bot = new Bot(deps.token)
  const seen = createSeen()

  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return
    await ctx.reply(
      [
        "Отметьте меня в группе и напишите задачу.",
        "Первая строка — название, дальше описание.",
        "Чтобы назначить исполнителя, отметьте его в том же сообщении.",
        "Команда и проект Linear берутся из настроек бота.",
      ].join("\n"),
    )
  })

  bot.on(["message:text", "message:caption"], async (ctx) => {
    await handleMention(ctx, deps.linear, seen)
  })

  bot.catch((error) => {
    console.error("Telegram handler failed", error.error)
  })

  return bot
}

async function handleMention(ctx: Context, linear: LinearGateway, seen: Seen): Promise<void> {
  const chat = ctx.chat
  const message = ctx.message
  if (!chat || !message) return
  if (chat.type !== "group" && chat.type !== "supergroup") return

  const text = message.text ?? message.caption
  if (!text) return

  const entities = message.entities ?? message.caption_entities ?? []
  if (entities.some((entity) => entity.type === "bot_command" && entity.offset === 0)) return

  const username = ctx.me.username
  if (!username) return

  const reply = message.reply_to_message
  const replyText = reply?.text ?? reply?.caption
  const parsed = parseMessage({
    text,
    entities: entities as TextEntity[],
    botUsername: username,
    botId: ctx.me.id,
    replyText,
  })
  if (!parsed.botMentioned) return
  if (!seen.begin(chat.id, message.message_id)) return

  if (!parsed.title) {
    try {
      await ctx.reply("Напишите название задачи в той же строке или со следующей.")
    } catch (error) {
      seen.forget(chat.id, message.message_id)
      throw error
    }
    return
  }

  let created = false
  try {
    const resolution = await linear.resolveAssignees(parsed.mentions)
    const issue = await linear.createIssue({
      title: parsed.title,
      description: buildDescription({
        body: parsed.body,
        replyText,
        titleSource: parsed.titleSource,
      }),
      messageLink: telegramMessageLink(chat.id, "username" in chat ? chat.username : undefined, message.message_id),
      linkTitle: messageLinkTitle(message.from),
      ...(resolution.assignee ? { assigneeId: resolution.assignee.id } : {}),
    })
    created = true
    const reply = formatSuccessReply(issue.identifier, issue.url)
    await ctx.reply(reply.text, { entities: reply.entities })
  } catch (error) {
    console.error(created ? "Created the Linear issue but failed to reply" : "Failed to create Linear issue", error)
    if (!created) {
      seen.forget(chat.id, message.message_id)
      await ctx.reply("Не смог создать задачу в Linear. Попробуйте ещё раз.")
    }
  }
}

function createSeen(ttlMs = DEDUPE_TTL_MS): Seen {
  const seen = new Map<string, number>()

  const prune = (now: number) => {
    if (seen.size < 1000) return
    for (const [key, at] of seen) {
      if (now - at > ttlMs) seen.delete(key)
    }
  }

  return {
    begin(chatId, messageId) {
      const now = Date.now()
      prune(now)
      const key = `${chatId}:${messageId}`
      const at = seen.get(key)
      if (at !== undefined && now - at <= ttlMs) return false
      seen.set(key, now)
      return true
    },
    forget(chatId, messageId) {
      seen.delete(`${chatId}:${messageId}`)
    },
  }
}
