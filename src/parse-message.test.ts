import { describe, expect, it } from "vitest"
import { parseMessage, type TextEntity } from "./parse-message.js"

const bot = "tl_bot"

function mention(text: string, raw: string, extra: Partial<TextEntity> = {}): TextEntity {
  const offset = text.indexOf(raw)
  if (offset < 0) throw new Error(`"${raw}" is not in the text`)
  return { type: "mention", offset, length: raw.length, ...extra }
}

describe("parseMessage", () => {
  it("uses the first line as the title and keeps the rest as the body", () => {
    const text = "@tl_bot Починить логин\nПадает после редиректа\n@ivan"
    const parsed = parseMessage({
      text,
      botUsername: bot,
      entities: [mention(text, "@tl_bot"), mention(text, "@ivan")],
    })

    expect(parsed.botMentioned).toBe(true)
    expect(parsed.title).toBe("Починить логин")
    expect(parsed.body).toBe("Падает после редиректа\n@ivan")
    expect(parsed.titleSource).toBe("message")
    expect(parsed.mentions).toEqual([{ username: "ivan", label: "@ivan" }])
  })

  it("strips other people from the title and keeps them as mentions", () => {
    const text = "@tl_bot @ivan поправь копирайт на главной"
    const parsed = parseMessage({
      text,
      botUsername: bot,
      entities: [mention(text, "@tl_bot"), mention(text, "@ivan")],
    })

    expect(parsed.title).toBe("поправь копирайт на главной")
    expect(parsed.body).toBe("")
    expect(parsed.mentions).toEqual([{ username: "ivan", label: "@ivan" }])
  })

  it("drops a mention from the middle of the title", () => {
    const text = "Починить логин @tl_bot срочно"
    const parsed = parseMessage({
      text,
      botUsername: "TL_Bot",
      entities: [mention(text, "@tl_bot")],
    })

    expect(parsed.botMentioned).toBe(true)
    expect(parsed.title).toBe("Починить логин срочно")
  })

  it("takes the title from the replied message when the mention has none", () => {
    const text = "@tl_bot @ivan"
    const parsed = parseMessage({
      text,
      botUsername: bot,
      entities: [mention(text, "@tl_bot"), mention(text, "@ivan")],
      replyText: "Починить логин\nПосле редиректа 500",
    })

    expect(parsed.title).toBe("Починить логин")
    expect(parsed.titleSource).toBe("reply")
    expect(parsed.body).toBe("")
    expect(parsed.mentions.map((item) => item.username)).toEqual(["ivan"])
  })

  it("asks for a title by returning null when there is no text", () => {
    const text = "@tl_bot"
    const parsed = parseMessage({
      text,
      botUsername: bot,
      entities: [mention(text, "@tl_bot")],
    })

    expect(parsed.botMentioned).toBe(true)
    expect(parsed.title).toBeNull()
    expect(parsed.titleSource).toBeNull()
  })

  it("ignores messages that do not mention the bot", () => {
    const text = "привет @ivan"
    const parsed = parseMessage({
      text,
      botUsername: bot,
      entities: [mention(text, "@ivan")],
    })

    expect(parsed.botMentioned).toBe(false)
    expect(parsed.mentions).toEqual([{ username: "ivan", label: "@ivan" }])
  })

  it("removes a text mention from the title and keeps the telegram id", () => {
    const text = "@tl_bot Иван поправь логин"
    const parsed = parseMessage({
      text,
      botUsername: bot,
      botId: 1,
      entities: [
        mention(text, "@tl_bot"),
        {
          type: "text_mention",
          offset: text.indexOf("Иван"),
          length: "Иван".length,
          user: { id: 42, first_name: "Иван" },
        },
      ],
    })

    expect(parsed.title).toBe("поправь логин")
    expect(parsed.mentions).toEqual([{ telegramId: 42, label: "Иван" }])
  })

  it("uses UTF-16 offsets, including emoji before the mention", () => {
    const text = "👍 @tl_bot Починить"
    const offset = text.indexOf("@tl_bot")
    const parsed = parseMessage({
      text,
      botUsername: bot,
      entities: [{ type: "mention", offset, length: "@tl_bot".length }],
    })

    expect(offset).toBe(3)
    expect(parsed.title).toBe("👍 Починить")
  })

  it("finds a mention without entities", () => {
    const parsed = parseMessage({
      text: "@tl_bot @ivan Обновить копирайт",
      botUsername: bot,
    })

    expect(parsed.botMentioned).toBe(true)
    expect(parsed.title).toBe("Обновить копирайт")
    expect(parsed.mentions).toEqual([{ username: "ivan", label: "@ivan" }])
  })

  it("does not treat an email as a mention", () => {
    const parsed = parseMessage({
      text: "напиши на a@ivan.com @tl_bot задачу",
      botUsername: bot,
    })

    expect(parsed.title).toBe("напиши на a@ivan.com задачу")
    expect(parsed.mentions).toEqual([])
  })
})
