export type TextEntity = {
  type: string
  offset: number
  length: number
  user?: {
    id: number
    username?: string
    first_name?: string
  }
}

export type Mention = {
  username?: string
  telegramId?: number
  label: string
}

export type ParseInput = {
  text: string
  entities?: TextEntity[]
  botUsername: string
  botId?: number
  replyText?: string
}

export type ParseResult = {
  botMentioned: boolean
  title: string | null
  body: string
  titleSource: "message" | "reply" | null
  mentions: Mention[]
}

type Range = {
  offset: number
  length: number
}

type LineSpan = {
  start: number
  end: number
  text: string
}

export function parseMessage(input: ParseInput): ParseResult {
  const botUsername = input.botUsername.replace(/^@/, "")
  const entities = input.entities ?? []
  const botRanges = botMentionRanges(input.text, entities, botUsername, input.botId)
  const entityPeople = entities.filter(
    (entity) => isPersonMention(entity) && !isBotMention(input.text, entity, botUsername, input.botId),
  )
  const covered = [...botRanges, ...entityPeople.map((entity) => ({ offset: entity.offset, length: entity.length }))]
  const people = [...entityPeople, ...uncoveredMentions(input.text, botUsername, covered)].sort(
    (left, right) => left.offset - right.offset,
  )

  const stripped = removeRanges(input.text, botRanges)
  const shiftedPeople = people.map((entity) => ({
    start: shiftOffset(entity.offset, botRanges),
    end: shiftOffset(entity.offset + entity.length, botRanges),
  }))
  const content = extractContent(stripped, shiftedPeople)

  let title = content.title
  let titleSource: ParseResult["titleSource"] = title ? "message" : null
  if (!title && input.replyText) {
    const fromReply = firstPlainLine(input.replyText)
    if (fromReply) {
      title = fromReply
      titleSource = "reply"
    }
  }

  return {
    botMentioned: botRanges.length > 0,
    title,
    body: content.body,
    titleSource,
    mentions: dedupeMentions(people.map((entity) => mentionFromEntity(input.text, entity))),
  }
}

function botMentionRanges(text: string, entities: TextEntity[], botUsername: string, botId: number | undefined): Range[] {
  const fromEntities = entities
    .filter((entity) => isBotMention(text, entity, botUsername, botId))
    .map((entity) => ({ offset: entity.offset, length: entity.length }))
  if (fromEntities.length > 0) return fromEntities
  return usernameRanges(text, botUsername)
}

function isBotMention(text: string, entity: TextEntity, botUsername: string, botId: number | undefined): boolean {
  if (entity.type === "mention") {
    const raw = text.slice(entity.offset, entity.offset + entity.length)
    return raw.replace(/^@/, "").toLowerCase() === botUsername.toLowerCase()
  }
  return entity.type === "text_mention" && botId !== undefined && entity.user?.id === botId
}

function isPersonMention(entity: TextEntity): boolean {
  return entity.type === "mention" || entity.type === "text_mention"
}

function mentionFromEntity(text: string, entity: TextEntity): Mention {
  if (entity.type === "text_mention") {
    const username = entity.user?.username?.replace(/^@/, "")
    const visible = text.slice(entity.offset, entity.offset + entity.length).trim()
    const label = username ? `@${username}` : visible || entity.user?.first_name || `id:${entity.user?.id ?? "?"}`
    return {
      ...(username ? { username: username.toLowerCase() } : {}),
      ...(entity.user ? { telegramId: entity.user.id } : {}),
      label,
    }
  }

  const username = text.slice(entity.offset, entity.offset + entity.length).replace(/^@/, "")
  return {
    username: username.toLowerCase(),
    label: `@${username}`,
  }
}

function dedupeMentions(mentions: Mention[]): Mention[] {
  const seen = new Set<string>()
  const unique: Mention[] = []
  for (const mention of mentions) {
    const key = mention.username ?? (mention.telegramId !== undefined ? `id:${mention.telegramId}` : mention.label)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(mention)
  }
  return unique
}

function extractContent(text: string, people: { start: number; end: number }[]): { title: string | null; body: string } {
  const lines = splitLines(text)
  let titleIndex = -1
  let title: string | null = null

  for (const [index, line] of lines.entries()) {
    const cleaned = cleanTitleLine(line, people)
    if (!cleaned) continue
    title = cleaned
    titleIndex = index
    break
  }

  if (titleIndex === -1) return { title: null, body: "" }

  const body = lines
    .slice(titleIndex + 1)
    .map((line) => line.text)
    .join("\n")
    .trim()
  return { title, body }
}

function cleanTitleLine(line: LineSpan, people: { start: number; end: number }[]): string {
  const ranges = people
    .filter((range) => range.end > line.start && range.start < line.end)
    .map((range) => ({
      offset: Math.max(range.start, line.start) - line.start,
      length: Math.min(range.end, line.end) - Math.max(range.start, line.start),
    }))
  const withoutPeople = removeRanges(line.text, ranges)
  return withoutPeople
    .replace(/(^|[^\w])@[A-Za-z0-9_]{1,32}/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

function firstPlainLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/(^|[^\w])@[A-Za-z0-9_]{1,32}/g, "$1").replace(/\s+/g, " ").trim()
    if (cleaned) return cleaned
  }
  return null
}

function mentionTokens(text: string): { offset: number; length: number; username: string }[] {
  const tokens: { offset: number; length: number; username: string }[] = []
  for (const match of text.matchAll(/@[A-Za-z0-9_]{1,32}/g)) {
    const offset = match.index
    if (offset === undefined) continue
    const previous = offset === 0 ? "" : (text[offset - 1] ?? "")
    if (/[A-Za-z0-9_]/.test(previous)) continue
    const raw = match[0]
    tokens.push({ offset, length: raw.length, username: raw.slice(1) })
  }
  return tokens
}

function usernameRanges(text: string, username: string): Range[] {
  const needle = username.toLowerCase()
  return mentionTokens(text)
    .filter((token) => token.username.toLowerCase() === needle)
    .map(({ offset, length }) => ({ offset, length }))
}

function uncoveredMentions(text: string, botUsername: string, covered: Range[]): TextEntity[] {
  const needle = botUsername.toLowerCase()
  return mentionTokens(text)
    .filter((token) => token.username.toLowerCase() !== needle)
    .filter((token) => !covered.some((range) => range.offset === token.offset))
    .map((token) => ({ type: "mention", offset: token.offset, length: token.length }))
}

function removeRanges(text: string, ranges: Range[]): string {
  const sorted = [...ranges].sort((left, right) => right.offset - left.offset)
  let result = text
  for (const range of sorted) {
    result = result.slice(0, range.offset) + result.slice(range.offset + range.length)
  }
  return result
}

function shiftOffset(offset: number, ranges: Range[]): number {
  let next = offset
  for (const range of [...ranges].sort((left, right) => left.offset - right.offset)) {
    if (range.offset >= offset) break
    const end = range.offset + range.length
    next -= end <= offset ? range.length : offset - range.offset
  }
  return next
}

function splitLines(text: string): LineSpan[] {
  const lines: LineSpan[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char !== "\n" && char !== "\r") continue
    lines.push({ start, end: index, text: text.slice(start, index) })
    if (char === "\r" && text[index + 1] === "\n") index += 1
    start = index + 1
  }
  lines.push({ start, end: text.length, text: text.slice(start) })
  return lines
}

