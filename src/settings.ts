export type ChatSettings = {
  linearApiKey: string
  teamId: string
  teamKey: string
  projectId: string | null
  projectName: string | null
  assigneeMap: Map<string, string>
}

export type DraftIntent = "setup" | "retarget" | "reproject" | "manage"

export type DraftStep = "key" | "team" | "project" | "assignees" | "settings" | "confirm-reset"

export type SetupDraft = {
  nonce: string
  expiresAt: number
  step: DraftStep
  intent: DraftIntent
  ephemeralMessageId?: number
  apiKey?: string
  teamId?: string
  teamKey?: string
  projectId?: string | null
  projectName?: string | null
  assigneeMap: [string, string][]
}

export const DRAFT_TTL_MS = 30 * 60 * 1000

export function entriesFromMap(map: Map<string, string>): [string, string][] {
  return [...map]
}

export function mapFromEntries(entries: [string, string][]): Map<string, string> {
  return new Map(entries)
}
