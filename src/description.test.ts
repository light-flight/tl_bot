import { describe, expect, it } from "vitest"
import { buildDescription, formatSuccessReply, messageLinkTitle, telegramMessageLink } from "./description.js"

describe("telegramMessageLink", () => {
  it("links a public chat by username", () => {
    expect(telegramMessageLink(-100123, "design", 15)).toBe("https://t.me/design/15")
  })

  it("links a private supergroup without the -100 prefix", () => {
    expect(telegramMessageLink(-1001234567890, undefined, 15)).toBe("https://t.me/c/1234567890/15")
  })
})

describe("buildDescription", () => {
  it("quotes the replied message and leaves out the footer", () => {
    const description = buildDescription({
      body: "Падает после редиректа",
      replyText: "Исходный баг\nещё строка",
      titleSource: "message",
    })

    expect(description).toBe(["Падает после редиректа", "", "> Исходный баг", "> ещё строка"].join("\n"))
  })

  it("uses the replied message once when the title came from it", () => {
    const description = buildDescription({
      body: "",
      replyText: "Починить логин\nдетали",
      titleSource: "reply",
    })

    expect(description).toBe("Починить логин\nдетали")
    expect(description).not.toContain("> Починить")
  })

  it("is empty when the message has no body", () => {
    expect(buildDescription({ body: "  ", titleSource: null })).toBe("")
  })
})

describe("messageLinkTitle", () => {
  it("uses the first and last name", () => {
    expect(messageLinkTitle({ first_name: "Georgy", last_name: "Yuriev", username: "georgy" })).toBe(
      "Georgy Yuriev – сообщение",
    )
  })

  it("uses a single name", () => {
    expect(messageLinkTitle({ first_name: "Georgy" })).toBe("Georgy – сообщение")
  })

  it("falls back to the username when there is no name", () => {
    expect(messageLinkTitle({ username: "georgy" })).toBe("@georgy – сообщение")
    expect(messageLinkTitle(undefined)).toBe("сообщение")
  })
})

describe("formatSuccessReply", () => {
  it("replies with the identifier as a link and nothing else", () => {
    const url = "https://linear.app/acme/issue/TL-12"
    const reply = formatSuccessReply("TL-12", url)

    expect(reply.text).toBe("TL-12")
    expect(reply.entities).toEqual([{ type: "text_link", offset: 0, length: "TL-12".length, url }])
  })
})
