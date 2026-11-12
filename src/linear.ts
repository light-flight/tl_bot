import { createHash } from "node:crypto"
import { LinearClient, type LinearFetch } from "@linear/sdk"
import { findMappedUser, resolveAssignee, type AssigneeResolution, type LinearUser } from "./assignees.js"
import { scrubSecrets } from "./secrets.js"
import type { ChatSettings, LinearCredential } from "./settings.js"
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
const TOKEN_URL = "https://api.linear.app/oauth/token"
const APP_SCOPE = "read,write"
const DAY_MS = 24 * 60 * 60 * 1000

type CachedToken = { accessToken: string; refreshAt: number }

const tokens = new Map<string, CachedToken>()

export class LinearGateway {
  private users: LinearUser[] = []

  private constructor(
    private readonly credential: LinearCredential,
    private readonly teamId: string,
    private readonly projectId: string | null,
    private readonly assigneeMap: ChatSettings["assigneeMap"],
  ) {}

  static async open(settings: ChatSettings): Promise<LinearGateway> {
    const gateway = new LinearGateway(settings.credential, settings.teamId, settings.projectId, settings.assigneeMap)
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
    const issue = await withClient(this.credential, async (client) => {
      const payload = await client.createIssue({
        teamId: this.teamId,
        title: input.title.slice(0, TITLE_LIMIT),
        description: input.description,
        ...(this.projectId ? { projectId: this.projectId } : {}),
        ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
      })
      const created = await payload.issue
      if (!payload.success || !created) throw new Error("Linear did not return an issue")
      return created
    })

    const linked = await withClient(this.credential, (client) =>
      client.attachmentLinkURL(issue.id, input.messageLink, { title: input.linkTitle }),
    )
    if (!linked.success) throw new Error("Linear did not link the message")

    return { identifier: issue.identifier, url: issue.url, title: issue.title }
  }

  private async refreshUsers(): Promise<void> {
    this.users = await withClient(this.credential, (client) => linearUsers(client))
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
    credential: settings.credential,
    teamId: settings.teamId,
    projectId: settings.projectId,
    assigneeMap: [...settings.assigneeMap].sort(([left], [right]) => left.localeCompare(right)),
  })
  return createHash("sha256").update(body).digest("hex")
}

export async function probeKey(credential: LinearCredential): Promise<KeyProbe> {
  try {
    const teams = await fetchTeams(credential)
    return { ok: true, teams }
  } catch (error) {
    return { ok: false, unauthorized: isLinearAuthError(error) }
  }
}

export async function fetchTeams(credential: LinearCredential): Promise<LinearTeam[]> {
  return withClient(credential, (client) => linearTeams(client))
}

export async function fetchProjects(credential: LinearCredential, teamId: string): Promise<LinearProject[]> {
  return withClient(credential, async (client) => {
    const team = await client.team(teamId)
    const projects = await collectAll((after) => team.projects({ first: 50, after }))
    return projects.map((project) => ({ id: project.id, name: project.name }))
  })
}

export async function fetchUsers(credential: LinearCredential): Promise<LinearUser[]> {
  return withClient(credential, (client) => linearUsers(client))
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

async function withClient<T>(credential: LinearCredential, run: (client: LinearClient) => Promise<T>): Promise<T> {
  try {
    return await run(await clientFor(credential))
  } catch (error) {
    const concealed = conceal(error, credential)
    if (credential.type !== "app" || !isLinearAuthError(concealed)) throw concealed
    invalidate(credential)
    try {
      return await run(await clientFor(credential, true))
    } catch (retryError) {
      throw conceal(retryError, credential)
    }
  }
}

async function clientFor(credential: LinearCredential, force = false): Promise<LinearClient> {
  if (credential.type === "personal") return new LinearClient({ apiKey: credential.apiKey })
  return new LinearClient({ accessToken: await appAccessToken(credential, force) })
}

async function appAccessToken(credential: Extract<LinearCredential, { type: "app" }>, force: boolean): Promise<string> {
  const key = cacheKey(credential)
  const cached = tokens.get(key)
  if (!force && cached && cached.refreshAt > Date.now()) return cached.accessToken

  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: APP_SCOPE,
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
      }),
      redirect: "error",
    })
  } catch (error) {
    throw conceal(error, credential)
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    const status = response.status === 400 ? 401 : response.status
    throw Object.assign(new Error("Linear rejected the application credentials"), { status })
  }

  let payload: { access_token?: unknown; expires_in?: unknown }
  try {
    payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown }
  } catch {
    throw new Error("Linear did not return an access token")
  }
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw Object.assign(new Error("Linear did not return an access token"), { status: 401 })
  }

  const expiresMs = (typeof payload.expires_in === "number" ? payload.expires_in : 30 * 24 * 60 * 60) * 1000
  tokens.set(key, { accessToken: payload.access_token, refreshAt: Date.now() + Math.max(0, expiresMs - DAY_MS) })
  return payload.access_token
}

function invalidate(credential: Extract<LinearCredential, { type: "app" }>): void {
  tokens.delete(cacheKey(credential))
}

function cacheKey(credential: Extract<LinearCredential, { type: "app" }>): string {
  return createHash("sha256").update(`${credential.clientId}\0${credential.clientSecret}`).digest("hex")
}

function conceal(error: unknown, credential: LinearCredential): unknown {
  if (!(error instanceof Error)) return error
  const message = redact(error.message, secretValues(credential))
  if (message === error.message) return error
  const wrapped = new Error(message)
  const status = statusOf(error)
  if (status !== undefined) Object.assign(wrapped, { status })
  return wrapped
}

function secretValues(credential: LinearCredential): string[] {
  if (credential.type === "personal") return [credential.apiKey]
  const cached = tokens.get(cacheKey(credential))?.accessToken
  return [credential.clientSecret, cached].filter((value): value is string => Boolean(value))
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((current, secret) => current.split(secret).join("[redacted]"), text)
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
