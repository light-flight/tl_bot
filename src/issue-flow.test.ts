import { describe, expect, it } from "vitest"
import { runMention } from "./issue-flow.js"
import type { ChatSettings } from "./settings.js"

const settings: ChatSettings = {
  credential: { type: "personal", apiKey: "lin_api_SUPERSECRET" },
  teamId: "team-1",
  teamKey: "TL",
  projectId: null,
  projectName: null,
  assigneeMap: new Map(),
}

describe("runMention", () => {
  it("does not call Linear when the chat is not configured", async () => {
    const outcome = await runMention({
      botMentioned: true,
      title: "Починить логин",
      settings: null,
      create: () => {
        throw new Error("Linear should not be called")
      },
    })

    expect(outcome).toEqual({ type: "setup" })
  })

  it("reports an authentication failure without the api key", async () => {
    const outcome = await runMention({
      botMentioned: true,
      title: "Починить логин",
      settings,
      create: () => {
        throw Object.assign(new Error("bad lin_api_SUPERSECRET"), { status: 401 })
      },
    })

    expect(outcome).toMatchObject({ type: "failed", auth: true })
    if (outcome.type === "failed") expect(outcome.detail).not.toContain("SUPERSECRET")
  })
})
