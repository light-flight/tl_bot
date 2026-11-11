import { describe, expect, it } from "vitest"
import { buildDescription, formatSuccessReply, telegramMessageLink } from "./description.js"

describe("telegramMessageLink", () => {
  it("links a public chat by username", () => {
    expect(telegramMessageLink(-100123, "design", 15)).toBe("https://t.me/design/15")
  })

  it("links a private supergroup without the -100 prefix", () => {
    expect(telegramMessageLink(-1001234567890, undefined, 15)).toBe("https://t.me/c/1234567890/15")
  })
})

describe("buildDescription", () => {
  it("quotes the replied message and lists other mentions", () => {
    const description = buildDescription({
      body: "Падает после редиректа",
      replyText: "Исходный баг\nещё строка",
      titleSource: "message",
      author: "@georgy",
      chatTitle: "Design",
      messageLink: "https://t.me/c/1/2",
      extraMentions: [{ username: "ivan", label: "@ivan" }],
    })

    expect(description).toBe(
      [
        "Падает после редиректа",
        "",
        "> Исходный баг",
        "> ещё строка",
        "",
        "---",
        "Источник: [сообщение](https://t.me/c/1/2)",
        "Автор: @georgy",
        "Чат: Design",
        "Также отмечены: @ivan",
      ].join("\n"),
    )
  })

  it("uses the replied message once when the title came from it", () => {
    const description = buildDescription({
      body: "",
      replyText: "Починить логин\nдетали",
      titleSource: "reply",
      author: "@georgy",
      chatTitle: "Design",
      messageLink: "https://t.me/c/1/2",
      extraMentions: [],
    })

    expect(description.startsWith("Починить логин\nдетали\n\n---")).toBe(true)
    expect(description).not.toContain("> Починить")
  })
})

describe("formatSuccessReply", () => {
  it("includes the assignee and why someone else was skipped", () => {
    const reply = formatSuccessReply({
      identifier: "TL-12",
      title: "Починить логин",
      url: "https://linear.app/acme/issue/TL-12",
      assigneeName: "Ivan",
      unresolved: [{ label: "@ghost", reason: "map_missing" }],
    })

    expect(reply).toBe(
      [
        "TL-12 — Починить логин",
        "https://linear.app/acme/issue/TL-12",
        "Исполнитель: Ivan",
        "Не назначил: @ghost — нет такого пользователя в Linear по ASSIGNEE_MAP",
      ].join("\n"),
    )
  })
})
