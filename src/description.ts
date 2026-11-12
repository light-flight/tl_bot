import type { Mention } from "./parse-message.js"

export type TextLinkEntity = {
  type: "text_link"
  offset: number
  length: number
  url: string
}

export function telegramMessageLink(chatId: number, username: string | undefined, messageId: number): string {
  if (username) return `https://t.me/${username}/${messageId}`
  const raw = String(chatId)
  const internal = raw.startsWith("-100") ? raw.slice(4) : raw.replace(/^-/, "")
  return `https://t.me/c/${internal}/${messageId}`
}

export function buildDescription(input: {
  body: string
  replyText?: string
  titleSource: "message" | "reply" | null
  author: string
  chatTitle: string
  messageLink: string
  extraMentions: Mention[]
}): string {
  const parts: string[] = []
  const body = input.body.trim()
  const reply = input.replyText?.trim()

  if (body) parts.push(body)
  if (reply && (input.titleSource === "message" || body)) parts.push(quote(reply))
  if (reply && input.titleSource === "reply" && !body) parts.push(reply)

  const footer = [
    "---",
    `Источник: [сообщение](${input.messageLink})`,
    `Автор: ${input.author}`,
    `Чат: ${input.chatTitle.replace(/\s+/g, " ").trim() || "чат"}`,
  ]
  if (input.extraMentions.length > 0) {
    footer.push(`Также отмечены: ${input.extraMentions.map((mention) => mention.label).join(", ")}`)
  }
  parts.push(footer.join("\n"))
  return parts.join("\n\n")
}

export function formatSuccessReply(identifier: string, url: string): { text: string; entities: TextLinkEntity[] } {
  return {
    text: identifier,
    entities: [{ type: "text_link", offset: 0, length: identifier.length, url }],
  }
}

function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")
}

