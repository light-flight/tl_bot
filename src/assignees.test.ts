import { describe, expect, it } from "vitest"
import { resolveAssignee, type LinearUser } from "./assignees.js"
import type { Mention } from "./parse-message.js"

const ivan: LinearUser = {
  id: "user-ivan",
  name: "Ivan Petrov",
  displayName: "Ivan",
  email: "ivan@example.com",
  active: true,
}

const georgy: LinearUser = {
  id: "user-georgy",
  name: "Georgy",
  displayName: "Georgy",
  email: "georgy@example.com",
  active: true,
}

function mention(username: string, telegramId?: number): Mention {
  return {
    username,
    label: `@${username}`,
    ...(telegramId !== undefined ? { telegramId } : {}),
  }
}

describe("resolveAssignee", () => {
  it("assigns the mapped Linear email", () => {
    const resolution = resolveAssignee([mention("gosha")], [georgy], new Map([["gosha", "georgy@example.com"]]))

    expect(resolution.assignee).toBe(georgy)
    expect(resolution.unresolved).toEqual([])
  })

  it("does not guess when the map points at an unknown email", () => {
    const resolution = resolveAssignee(
      [mention("gosha")],
      [georgy],
      new Map([["gosha", "missing@example.com"]]),
    )

    expect(resolution.assignee).toBeNull()
    expect(resolution.unresolved).toEqual([{ mention: mention("gosha"), reason: "map_missing" }])
  })

  it("assigns a numeric telegram id from the map", () => {
    const person = mention("ivan", 42)
    const resolution = resolveAssignee([person], [ivan], new Map([["42", "user-ivan"]]))

    expect(resolution.assignee?.id).toBe("user-ivan")
  })

  it("falls back to a unique email local-part", () => {
    const resolution = resolveAssignee([mention("ivan")], [ivan, georgy], new Map())

    expect(resolution.assignee).toBe(ivan)
  })

  it("falls back to a unique display name", () => {
    const user: LinearUser = { ...ivan, email: "other@example.com", displayName: "ivan" }
    const resolution = resolveAssignee([mention("ivan")], [user], new Map())

    expect(resolution.assignee).toBe(user)
  })

  it("leaves the issue unassigned when several people match", () => {
    const other: LinearUser = { ...georgy, displayName: "ivan", email: "other@example.com" }
    const person = mention("ivan")
    const resolution = resolveAssignee([person], [ivan, other], new Map())

    expect(resolution.assignee).toBeNull()
    expect(resolution.unresolved).toEqual([{ mention: person, reason: "ambiguous" }])
  })

  it("uses the next mention when the first one does not match", () => {
    const ghost = mention("ghost")
    const resolution = resolveAssignee([ghost, mention("ivan")], [ivan], new Map())

    expect(resolution.assignee).toBe(ivan)
    expect(resolution.unresolved).toEqual([{ mention: ghost, reason: "not_found" }])
    expect(resolution.extraMentions).toEqual([ghost])
  })

  it("ignores inactive users", () => {
    const resolution = resolveAssignee([mention("ivan")], [{ ...ivan, active: false }], new Map())

    expect(resolution.assignee).toBeNull()
    expect(resolution.unresolved[0]?.reason).toBe("not_found")
  })

  it("returns no assignee when nobody was mentioned", () => {
    const resolution = resolveAssignee([], [ivan], new Map([["ivan", "ivan@example.com"]]))

    expect(resolution).toEqual({ assignee: null, unresolved: [], extraMentions: [] })
  })
})
