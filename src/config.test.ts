import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { loadConfig, parseAssigneeMap } from "./config.js"

const settingsKey = randomBytes(32).toString("base64")

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "telegram-token",
  SETTINGS_KEY: settingsKey,
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
  it("reads the settings key and the default database path", () => {
    const config = loadConfig({ ...baseEnv, PORT: "3000" })

    expect(config.settingsKey).toEqual(Buffer.from(settingsKey, "base64"))
    expect(config.databasePath).toBe("data/settings.sqlite")
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

  it("rejects a settings key of the wrong length", () => {
    expect(() => loadConfig({ ...baseEnv, SETTINGS_KEY: "short" })).toThrow(/SETTINGS_KEY/)
  })
})
