import { describe, expect, it } from "vitest"
import type { LinearUser } from "./assignees.js"
import {
  acceptWizardCallback,
  connectedCard,
  createDraft,
  keyDecision,
  onboardingCard,
  parseWizardData,
  projectButtons,
  settingsText,
  startSetup,
  teamButtons,
  validateAssignees,
} from "./setup.js"
import type { ChatSettings } from "./settings.js"

const georgy: LinearUser = {
  id: "user-georgy",
  name: "Georgy",
  displayName: "Georgy",
  email: "georgy@example.com",
  active: true,
}

function saved(): ChatSettings {
  return {
    linearApiKey: "lin_api_SUPERSECRET",
    teamId: "team-1",
    teamKey: "TL",
    projectId: null,
    projectName: null,
    assigneeMap: new Map([["georgy", "georgy@example.com"]]),
  }
}

describe("onboarding card", () => {
  it("offers a single setup button before the chat is configured", () => {
    expect(onboardingCard(null).buttons).toEqual([[{ text: "Настроить", data: "onboard", style: "primary" }]])
  })

  it("keeps the api key out of the public and settings text", () => {
    const settings = saved()

    expect(connectedCard(settings, false).text).not.toContain("lin_api_SUPERSECRET")
    expect(settingsText(settings)).not.toContain("lin_api_SUPERSECRET")
    expect(settingsText(settings)).toContain("Ключ сохранён")
  })
})

describe("startSetup", () => {
  it("does not create a draft for someone who is not an admin", () => {
    expect(startSetup({ isAdmin: false, now: 1_000 })).toEqual({ ok: false })
    expect(startSetup({ isAdmin: true, now: 1_000 }).ok).toBe(true)
  })
})

describe("wizard callbacks", () => {
  it("rejects a nonce that does not belong to the draft", () => {
    const draft = createDraft(1_000, "setup", "team")

    expect(acceptWizardCallback(draft, "ffffffff", draft.expiresAt - 1)).toBe(false)
    expect(acceptWizardCallback(draft, draft.nonce, draft.expiresAt - 1)).toBe(true)
    expect(acceptWizardCallback(null, draft.nonce, draft.expiresAt - 1)).toBe(false)
  })

  it("roundtrips a team button inside the callback limit", () => {
    const id = "12345678-1234-1234-1234-123456789abc"
    const nonce = "abcd1234"
    const data = teamButtons(nonce, [{ id, key: "TL", name: "Team" }], 0)[0]?.[0]?.data ?? ""

    expect(data.length).toBeLessThanOrEqual(64)
    expect(parseWizardData(data)).toEqual({ nonce, action: { type: "team", id } })
  })

  it("reads the skip-project button", () => {
    const data = projectButtons("abcd1234", [], 0).at(-1)?.[0]?.data ?? ""

    expect(parseWizardData(data)).toEqual({ nonce: "abcd1234", action: { type: "no-project" } })
  })
})

describe("keyDecision", () => {
  it("refuses a key that arrived as a public message", () => {
    expect(keyDecision({ ephemeral: false, argument: "lin_api_SUPERSECRET" })).toEqual({ type: "not-hidden" })
  })

  it("accepts a hidden linear key and rejects a malformed one", () => {
    expect(keyDecision({ ephemeral: true, argument: " lin_api_abc " })).toEqual({ type: "ready", key: "lin_api_abc" })
    expect(keyDecision({ ephemeral: true, argument: "secret" })).toEqual({ type: "bad-format" })
    expect(keyDecision({ ephemeral: true, argument: "" })).toEqual({ type: "empty" })
  })
})

describe("validateAssignees", () => {
  it("rejects the whole map when one entry is missing in Linear", () => {
    const result = validateAssignees("georgy:georgy@example.com, ivan:ivan@example.com", [georgy])

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("ivan")
  })

  it("names the Linear user without repeating the email", () => {
    const result = validateAssignees(" @Georgy : georgy@example.com ", [georgy])

    expect(result).toEqual({ ok: true, map: new Map([["georgy", "georgy@example.com"]]), lines: ["georgy → Georgy"] })
  })
})
