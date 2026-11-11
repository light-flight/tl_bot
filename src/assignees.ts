import type { Mention } from "./parse-message.js"

export type LinearUser = {
  id: string
  name: string
  displayName: string
  email: string
  active: boolean
}

export type UnresolvedReason = "map_missing" | "ambiguous" | "not_found"

export type UnresolvedMention = {
  mention: Mention
  reason: UnresolvedReason
}

export type AssigneeResolution = {
  assignee: LinearUser | null
  unresolved: UnresolvedMention[]
  extraMentions: Mention[]
}

export function resolveAssignee(
  mentions: Mention[],
  users: LinearUser[],
  assigneeMap: ReadonlyMap<string, string>,
): AssigneeResolution {
  const active = users.filter((user) => user.active)
  let assignee: LinearUser | null = null
  let assigneeMention: Mention | undefined
  const unresolved: UnresolvedMention[] = []

  for (const mention of mentions) {
    const matched = matchMention(mention, active, assigneeMap)
    if (matched.kind === "matched") {
      if (!assignee) {
        assignee = matched.user
        assigneeMention = mention
      }
      continue
    }
    unresolved.push({ mention, reason: matched.reason })
  }

  return {
    assignee,
    unresolved,
    extraMentions: mentions.filter((mention) => mention !== assigneeMention),
  }
}

type MatchResult = { kind: "matched"; user: LinearUser } | { kind: "unresolved"; reason: UnresolvedReason }

function matchMention(mention: Mention, users: LinearUser[], assigneeMap: ReadonlyMap<string, string>): MatchResult {
  const mapped = lookupMap(mention, assigneeMap)
  if (mapped !== null) {
    const user = findMappedUser(users, mapped)
    if (!user) return { kind: "unresolved", reason: "map_missing" }
    return { kind: "matched", user }
  }

  const username = mention.username?.toLowerCase()
  if (!username) return { kind: "unresolved", reason: "not_found" }

  const candidates = users.filter((user) => userMatchesUsername(user, username))
  if (candidates.length === 1) return { kind: "matched", user: candidates[0]! }
  if (candidates.length > 1) return { kind: "unresolved", reason: "ambiguous" }
  return { kind: "unresolved", reason: "not_found" }
}

function lookupMap(mention: Mention, assigneeMap: ReadonlyMap<string, string>): string | null {
  if (mention.username) {
    const byUsername = assigneeMap.get(mention.username.toLowerCase())
    if (byUsername) return byUsername
  }
  if (mention.telegramId !== undefined) {
    const byId = assigneeMap.get(String(mention.telegramId))
    if (byId) return byId
  }
  return null
}

function findMappedUser(users: LinearUser[], value: string): LinearUser | undefined {
  const needle = value.toLowerCase()
  if (value.includes("@")) return users.find((user) => user.email.toLowerCase() === needle)
  return users.find((user) => user.id === value)
}

function userMatchesUsername(user: LinearUser, username: string): boolean {
  const localPart = user.email.split("@")[0]?.toLowerCase() ?? ""
  return localPart === username || user.displayName.toLowerCase() === username || user.name.toLowerCase() === username
}
