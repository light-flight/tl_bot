import { createHash } from "node:crypto"
import { LinearClient, type LinearFetch } from "@linear/sdk"
import { findMappedUser, resolveAssignee, type AssigneeResolution, type LinearUser } from "./assignees.js"
import { scrubSecrets } from "./secrets.js"
import type { ChatSettings } from "./settings.js"
import type { Mention } from "./parse-message.js"

export type CreatedIssue = {
  identifier: string
  url: string
  title: string
}

export type LinearTeam = {
  id: string
  key: string
  name: string
}

export type LinearProject = {
  id: string
  name: string
}

export type KeyProbe = { ok: true; teams: LinearTeam[] } | { ok: false; unauthorized: boolean }

const TITLE_LIMIT = 255

export class LinearGateway {
  private users: LinearUser[] = []

  private constructor(
    private readonly client: LinearClient,
    private readonly teamId: string,
    private readonly projectId: string | null,
    private readonly assigneeMap: ChatSettings["assigneeMap"],
  ) {}

  static async open(settings: ChatSettings): Promise<LinearGateway> {
    const client = new LinearClient({ apiKey: settings.linearApiKey })
    const gateway = new LinearGateway(client, settings.teamId, settings.projectId, settings.assigneeMap)
    await gateway.refreshUsers()
    return gateway
  }

  async resolveAssignees(mentions: Mention[]): Promise<AssigneeResolution> {
    let resolution = resolveAssignee(mentions, this.users, this.assigneeMap)
    if (resolution.unresolved.length === 0) return resolution

    await this.refreshUsers()
    resolution = resolveAssignee(mentions, this.users, this.assigneeMap)
    return resolution
  }

  async createIssue(input: {
    title: string
    description: string
    messageLink: string
    linkTitle: string
    assigneeId?: string
  }): Promise<CreatedIssue> {
    const payload = await this.client.createIssue({
      teamId: this.teamId,
      title: input.title.slice(0, TITLE_LIMIT),
      description: input.description,
      ...(this.projectId ? { projectId: this.projectId } : {}),
      ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
    })
    const issue = await payload.issue
    if (!payload.success || !issue) throw new Error("Linear did not return an issue")

    const linked = await this.client.attachmentLinkURL(issue.id, input.messageLink, { title: input.linkTitle })
    if (!linked.success) throw new Error("Linear did not link the message")

    return { identifier: issue.identifier, url: issue.url, title: issue.title }
  }

  private async refreshUsers(): Promise<void> {
    this.users = await linearUsers(this.client)
  }
}

export class GatewayPool {
  private readonly cache = new Map<string, { fingerprint: string; gateway: LinearGateway }>()

  constructor(private readonly open: (settings: ChatSettings) => Promise<LinearGateway> = (settings) => LinearGateway.open(settings)) {}

  async forChat(chatId: string, settings: ChatSettings): Promise<LinearGateway> {
    const fingerprint = settingsFingerprint(settings)
    const cached = this.cache.get(chatId)
    if (cached?.fingerprint === fingerprint) return cached.gateway
    const gateway = await this.open(settings)
    this.cache.set(chatId, { fingerprint, gateway })
    return gateway
  }

  drop(chatId: string): void {
    this.cache.delete(chatId)
  }
}

export function settingsFingerprint(settings: ChatSettings): string {
  const body = JSON.stringify({
    linearApiKey: settings.linearApiKey,
    teamId: settings.teamId,
    projectId: settings.projectId,
    assigneeMap: [...settings.assigneeMap].sort(([left], [right]) => left.localeCompare(right)),
  })
  return createHash("sha256").update(body).digest("hex")
}

export async function probeKey(apiKey: string): Promise<KeyProbe> {
  try {
    const teams = await linearTeams(new LinearClient({ apiKey }))
    return { ok: true, teams }
  } catch (error) {
    return { ok: false, unauthorized: isLinearAuthError(error) }
  }
}

export async function fetchTeams(apiKey: string): Promise<LinearTeam[]> {
  return linearTeams(new LinearClient({ apiKey }))
}

export async function fetchProjects(apiKey: string, teamId: string): Promise<LinearProject[]> {
  const client = new LinearClient({ apiKey })
  const team = await client.team(teamId)
  const projects = await collectAll((after) => team.projects({ first: 50, after }))
  return projects.map((project) => ({ id: project.id, name: project.name }))
}

export async function fetchUsers(apiKey: string): Promise<LinearUser[]> {
  return linearUsers(new LinearClient({ apiKey }))
}

export function isLinearAuthError(error: unknown): boolean {
  const status = statusOf(error)
  if (status === 401 || status === 403) return true
  const message = error instanceof Error ? error.message : ""
  return /authentication|not authenticated|unauthorized/i.test(scrubSecrets(message))
}

export function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error"
  return scrubSecrets(message)
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  if ("status" in error && typeof error.status === "number") return error.status
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode
  return undefined
}

async function linearTeams(client: LinearClient): Promise<LinearTeam[]> {
  const teams = await collectAll((after) => client.teams({ first: 50, after }))
  return teams.map((team) => ({ id: team.id, key: team.key, name: team.name }))
}

async function linearUsers(client: LinearClient): Promise<LinearUser[]> {
  const users = await collectAll((after) => client.users({ first: 100, after }))
  return users
    .filter((user) => user.active && user.isAssignable && !user.app)
    .map((user) => ({
      id: user.id,
      name: user.name,
      displayName: user.displayName,
      email: user.email ?? "",
      active: true,
    }))
}

type Page<T> = {
  nodes: T[]
  pageInfo: { hasNextPage: boolean; endCursor?: string | null }
}

async function collectAll<T>(fetchPage: (after?: string) => LinearFetch<Page<T>>): Promise<T[]> {
  const items: T[] = []
  let after: string | undefined
  do {
    const page = await fetchPage(after)
    items.push(...page.nodes)
    after = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined
  } while (after)
  return items
}
