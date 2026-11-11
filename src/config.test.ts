import { describe, expect, it } from "vitest"
import { loadConfig, parseAssigneeMap } from "./config.js"

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "telegram-token",
  LINEAR_API_KEY: "lin_api",
  LINEAR_TEAM: "TL",
  TELEGRAM_WEBHOOK_SECRET: "secret",
  WEBHOOK_URL: "https://bot.example.com/telegram/webhook",
}

describe("parseAssigneeMap", () => {
  it("normalizes usernames and keeps emails", () => {
    expect(parseAssigneeMap(" @Georgy : georgy@example.com , 42:user-id ")).toEqual(
      new Map([
        ["georgy", "georgy@example.com"],
        ["42", "user-id"],
      ]),
    )
  })

  it("rejects an entry without a value", () => {
    expect(() => parseAssigneeMap("georgy:")).toThrow(/key:value/)
  })
})

describe("loadConfig", () => {
  it("reads an empty project as unset", () => {
    const config = loadConfig({ ...baseEnv, LINEAR_PROJECT: "  ", PORT: "3000" })

    expect(config.linearProject).toBeNull()
    expect(config.webhookUrl).toBe("https://bot.example.com/telegram/webhook")
    expect(config.port).toBe(3000)
  })

  it("requires the webhook secret", () => {
    expect(() => loadConfig({ ...baseEnv, TELEGRAM_WEBHOOK_SECRET: "" })).toThrow(/TELEGRAM_WEBHOOK_SECRET/)
  })

  it("rejects a webhook URL without https", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        WEBHOOK_URL: "http://bot.example.com/hook",
        TELEGRAM_WEBHOOK_SECRET: "secret",
      }),
    ).toThrow(/https/)
  })
})
