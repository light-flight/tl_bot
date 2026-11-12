import { buildDescription, formatSuccessReply, type TextLinkEntity } from "./description.js"
import { cleanError, isLinearAuthError, type CreatedIssue } from "./linear.js"
import type { ChatSettings } from "./settings.js"

export type MentionOutcome =
  | { type: "ignore" }
  | { type: "setup" }
  | { type: "need-title" }
  | { type: "created"; text: string; entities: TextLinkEntity[] }
  | { type: "failed"; auth: boolean; detail: string }

export async function runMention(input: {
  botMentioned: boolean
  title: string | null
  settings: ChatSettings | null
  create: () => Promise<CreatedIssue>
}): Promise<MentionOutcome> {
  if (!input.botMentioned) return { type: "ignore" }
  if (!input.settings) return { type: "setup" }
  if (!input.title) return { type: "need-title" }
  try {
    const issue = await input.create()
    const reply = formatSuccessReply(issue.identifier, issue.url)
    return { type: "created", text: reply.text, entities: reply.entities }
  } catch (error) {
    return { type: "failed", auth: isLinearAuthError(error), detail: cleanError(error) }
  }
}

export function issueDescription(input: {
  body: string
  replyText?: string
  titleSource: "message" | "reply" | null
}): string {
  return buildDescription(input)
}
