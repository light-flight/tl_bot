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
}): string {
  const parts: string[] = []
  const body = input.body.trim()
  const reply = input.replyText?.trim()

  if (body) parts.push(body)
  if (reply && (input.titleSource === "message" || body)) parts.push(quote(reply))
  if (reply && input.titleSource === "reply" && !body) parts.push(reply)

  return parts.join("\n\n")
}

export function messageLinkTitle(
  from: { first_name?: string; last_name?: string; username?: string } | undefined,
): string {
  const name = [from?.first_name, from?.last_name]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ")
  if (name) return `${name} – сообщение`
  const username = from?.username?.replace(/^@/, "").trim()
  if (username) return `@${username} – сообщение`
  return "сообщение"
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

