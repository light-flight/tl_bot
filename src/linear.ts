import { LinearClient, type LinearFetch } from "@linear/sdk"
import { resolveAssignee, type AssigneeResolution, type LinearUser } from "./assignees.js"
import type { AppConfig } from "./config.js"
import type { Mention } from "./parse-message.js"

export type CreatedIssue = {
  identifier: string
  url: string
  title: string
}

const TITLE_LIMIT = 255

export class LinearGateway {
  private users: LinearUser[] = []

  private constructor(
    private readonly client: LinearClient,
    private readonly teamId: string,
    private readonly projectId: string | null,
    private readonly assigneeMap: AppConfig["assigneeMap"],
  ) {}

  static async connect(config: AppConfig): Promise<LinearGateway> {
    const client = new LinearClient({ apiKey: config.linearApiKey })
    const teams = await collectAll((after) => client.teams({ first: 50, after }))
    const needle = config.linearTeam.toLowerCase()
    const team = teams.find((item) => item.id.toLowerCase() === needle || item.key.toLowerCase() === needle)
    if (!team) throw new Error(`Linear team not found: ${config.linearTeam}`)

    let projectId: string | null = null
    if (config.linearProject) {
      const projects = await collectAll((after) => team.projects({ first: 50, after }))
      const projectNeedle = config.linearProject.toLowerCase()
      const matches = projects.filter(
        (project) => project.id.toLowerCase() === projectNeedle || project.name.toLowerCase() === projectNeedle,
      )
      const project = matches[0]
      if (matches.length !== 1 || !project) {
        throw new Error(`Linear project not found in team ${team.key}: ${config.linearProject}`)
      }
      projectId = project.id
    }

    const gateway = new LinearGateway(client, team.id, projectId, config.assigneeMap)
    await gateway.refreshUsers()
    console.log(`Linear team ${team.key} (${team.id})${projectId ? `, project ${projectId}` : ""}`)
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
    const users = await collectAll((after) => this.client.users({ first: 100, after }))
    this.users = users
      .filter((user) => user.active && user.isAssignable && !user.app)
      .map((user) => ({
        id: user.id,
        name: user.name,
        displayName: user.displayName,
        email: user.email,
        active: true,
      }))
  }
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
