import { describe, expect, it } from "vitest"
import { GatewayPool, settingsFingerprint, type LinearGateway } from "./linear.js"
import type { ChatSettings } from "./settings.js"

function settings(apiKey: string): ChatSettings {
  return {
    linearApiKey: apiKey,
    teamId: "team-1",
    teamKey: "TL",
    projectId: null,
    projectName: null,
    assigneeMap: new Map(),
  }
}

describe("GatewayPool", () => {
  it("reuses a client until the chat settings change", async () => {
    const opened: string[] = []
    const pool = new GatewayPool(async (value) => {
      opened.push(value.linearApiKey)
      return { opened: opened.length } as unknown as LinearGateway
    })

    const first = settings("lin_api_one")
    expect(await pool.forChat("-100", first)).toBe(await pool.forChat("-100", first))
    expect(opened).toEqual(["lin_api_one"])

    pool.drop("-100")
    await pool.forChat("-100", first)
    expect(opened).toEqual(["lin_api_one", "lin_api_one"])

    await pool.forChat("-100", settings("lin_api_two"))
    expect(opened).toEqual(["lin_api_one", "lin_api_one", "lin_api_two"])
  })
})

describe("settingsFingerprint", () => {
  it("does not contain the api key", () => {
    expect(settingsFingerprint(settings("lin_api_SUPERSECRET"))).not.toContain("SUPERSECRET")
  })
})
