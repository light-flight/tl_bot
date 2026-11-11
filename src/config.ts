import { z } from "zod"

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  LINEAR_API_KEY: z.string().min(1),
  LINEAR_TEAM: z.string().min(1),
  LINEAR_PROJECT: z.string().optional().default(""),
  ASSIGNEE_MAP: z.string().optional().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  WEBHOOK_URL: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === "https:", "WEBHOOK_URL must use https"),
  PORT: z.coerce.number().int().positive().default(3000),
})

export type AssigneeMap = Map<string, string>

export type AppConfig = {
  telegramBotToken: string
  linearApiKey: string
  linearTeam: string
  linearProject: string | null
  assigneeMap: AssigneeMap
  webhookSecret: string
  webhookUrl: string
  port: number
}

export function parseAssigneeMap(raw: string): AssigneeMap {
  const map: AssigneeMap = new Map()
  for (const part of raw.split(",")) {
    const trimmed = part.trim()
    if (!trimmed) continue

    const separator = trimmed.indexOf(":")
    if (separator <= 0) {
      throw new Error(`ASSIGNEE_MAP entry must be key:value, got "${trimmed}"`)
    }

    const key = trimmed.slice(0, separator).trim().replace(/^@/, "").toLowerCase()
    const value = trimmed.slice(separator + 1).trim()
    if (!key || !value) {
      throw new Error(`ASSIGNEE_MAP entry must be key:value, got "${trimmed}"`)
    }

    map.set(key, value)
  }
  return map
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`).join("; ")
    throw new Error(`Invalid configuration: ${details}`)
  }

  const value = parsed.data
  return {
    telegramBotToken: value.TELEGRAM_BOT_TOKEN,
    linearApiKey: value.LINEAR_API_KEY,
    linearTeam: value.LINEAR_TEAM,
    linearProject: value.LINEAR_PROJECT.trim() || null,
    assigneeMap: parseAssigneeMap(value.ASSIGNEE_MAP),
    webhookSecret: value.TELEGRAM_WEBHOOK_SECRET,
    webhookUrl: value.WEBHOOK_URL,
    port: value.PORT,
  }
}
