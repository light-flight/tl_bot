import { chmodSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { decrypt, DecryptError, encrypt } from "./secrets.js"
import {
  mapFromEntries,
  type ChatSettings,
  type LinearCredential,
  type SetupDraft,
} from "./settings.js"

const credentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("personal"), apiKey: z.string().min(1) }),
  z.object({ type: z.literal("app"), clientId: z.string().min(1), clientSecret: z.string().min(1) }),
])

const settingsSchema = z
  .object({
    credential: credentialSchema.optional(),
    linearApiKey: z.string().min(1).optional(),
    teamId: z.string().min(1),
    teamKey: z.string().min(1),
    projectId: z.string().nullable(),
    projectName: z.string().nullable(),
    assigneeMap: z.array(z.tuple([z.string(), z.string()])),
  })
  .superRefine((value, ctx) => {
    if (!value.credential && !value.linearApiKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "missing linear credential" })
    }
  })

const draftSchema = z.object({
  nonce: z.string().regex(/^[0-9a-f]{8}$/),
  expiresAt: z.number(),
  step: z.enum(["key", "team", "project", "assignees", "settings", "confirm-reset"]),
  intent: z.enum(["setup", "retarget", "reproject", "manage"]),
  ephemeralMessageId: z.number().optional(),
  credential: credentialSchema.optional(),
  apiKey: z.string().optional(),
  teamId: z.string().optional(),
  teamKey: z.string().optional(),
  projectId: z.string().nullable().optional(),
  projectName: z.string().nullable().optional(),
  assigneeMap: z.array(z.tuple([z.string(), z.string()])).default([]),
})

export type SettingsStore = {
  close: () => void
  get: (chatId: string) => ChatSettings | null
  save: (chatId: string, settings: ChatSettings) => void
  forgetChat: (chatId: string) => void
  moveChat: (fromChatId: string, toChatId: string) => void
  getDraft: (chatId: string, userId: string, now?: number) => SetupDraft | null
  saveDraft: (chatId: string, userId: string, draft: SetupDraft) => void
  deleteDraft: (chatId: string, userId: string) => void
  getCard: (chatId: string) => number | null
  saveCard: (chatId: string, messageId: number) => void
}

export function openStore(path: string, key: Buffer, now = Date.now()): SettingsStore {
  if (path !== ":memory:") {
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (directory !== tmpdir()) chmodSync(directory, 0o700)
  }

  const db = new DatabaseSync(path)
  if (path !== ":memory:") chmodSync(path, 0o600)
  db.exec("PRAGMA journal_mode = DELETE")
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_settings (
      chat_id TEXT PRIMARY KEY,
      ciphertext BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS setup_drafts (
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS chat_cards (
      chat_id TEXT PRIMARY KEY,
      message_id INTEGER NOT NULL
    );
  `)

  const statements = {
    getSettings: db.prepare("SELECT ciphertext FROM chat_settings WHERE chat_id = ?"),
    allSettings: db.prepare("SELECT chat_id, ciphertext FROM chat_settings"),
    saveSettings: db.prepare(
      "INSERT INTO chat_settings (chat_id, ciphertext, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at",
    ),
    deleteSettings: db.prepare("DELETE FROM chat_settings WHERE chat_id = ?"),
    getDraft: db.prepare("SELECT ciphertext, expires_at FROM setup_drafts WHERE chat_id = ? AND user_id = ?"),
    allDrafts: db.prepare("SELECT chat_id, user_id, ciphertext FROM setup_drafts"),
    draftsForChat: db.prepare("SELECT user_id, ciphertext FROM setup_drafts WHERE chat_id = ?"),
    saveDraft: db.prepare(
      "INSERT INTO setup_drafts (chat_id, user_id, ciphertext, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET ciphertext = excluded.ciphertext, expires_at = excluded.expires_at",
    ),
    deleteDraft: db.prepare("DELETE FROM setup_drafts WHERE chat_id = ? AND user_id = ?"),
    deleteDrafts: db.prepare("DELETE FROM setup_drafts WHERE chat_id = ?"),
    deleteExpired: db.prepare("DELETE FROM setup_drafts WHERE expires_at <= ?"),
    getCard: db.prepare("SELECT message_id FROM chat_cards WHERE chat_id = ?"),
    saveCard: db.prepare(
      "INSERT INTO chat_cards (chat_id, message_id) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET message_id = excluded.message_id",
    ),
    deleteCard: db.prepare("DELETE FROM chat_cards WHERE chat_id = ?"),
  }

  const sweep = (at: number) => {
    statements.deleteExpired.run(at)
  }

  sweep(now)
  dropCorruptDrafts()
  assertSettingsReadable()

  function settingsAad(chatId: string): string {
    return `chat:${chatId}`
  }

  function draftAad(chatId: string, userId: string): string {
    return `draft:${chatId}:${userId}`
  }

  function readSettings(chatId: string, payload: Uint8Array): ChatSettings {
    const parsed = settingsSchema.parse(JSON.parse(decrypt(key, settingsAad(chatId), Buffer.from(payload))))
    return {
      credential: credentialFrom(parsed),
      teamId: parsed.teamId,
      teamKey: parsed.teamKey,
      projectId: parsed.projectId,
      projectName: parsed.projectName,
      assigneeMap: mapFromEntries(parsed.assigneeMap),
    }
  }

  function readDraft(chatId: string, userId: string, payload: Uint8Array): SetupDraft {
    const parsed = draftSchema.parse(JSON.parse(decrypt(key, draftAad(chatId, userId), Buffer.from(payload))))
    const credential =
      parsed.credential ?? (parsed.apiKey ? { type: "personal" as const, apiKey: parsed.apiKey } : undefined)
    return {
      nonce: parsed.nonce,
      expiresAt: parsed.expiresAt,
      step: parsed.step,
      intent: parsed.intent,
      ...(parsed.ephemeralMessageId !== undefined ? { ephemeralMessageId: parsed.ephemeralMessageId } : {}),
      ...(credential ? { credential } : {}),
      ...(parsed.teamId !== undefined ? { teamId: parsed.teamId } : {}),
      ...(parsed.teamKey !== undefined ? { teamKey: parsed.teamKey } : {}),
      ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
      ...(parsed.projectName !== undefined ? { projectName: parsed.projectName } : {}),
      assigneeMap: parsed.assigneeMap,
    }
  }

  function assertSettingsReadable(): void {
    for (const row of statements.allSettings.all()) {
      const chatId = String(row.chat_id)
      try {
        readSettings(chatId, blob(row.ciphertext))
      } catch (error) {
        if (error instanceof DecryptError) {
          throw new Error(`SETTINGS_KEY does not match the database (chat ${chatId})`)
        }
        throw error
      }
    }
  }

  function dropCorruptDrafts(): void {
    for (const row of statements.allDrafts.all()) {
      const chatId = String(row.chat_id)
      const userId = String(row.user_id)
      try {
        readDraft(chatId, userId, blob(row.ciphertext))
      } catch {
        statements.deleteDraft.run(chatId, userId)
      }
    }
  }

  return {
    close() {
      db.close()
    },
    get(chatId) {
      const row = statements.getSettings.get(chatId)
      if (!row) return null
      return readSettings(chatId, blob(row.ciphertext))
    },
    save(chatId, settings) {
      statements.saveSettings.run(chatId, encrypt(key, settingsAad(chatId), settingsJson(settings)), Date.now())
    },
    forgetChat(chatId) {
      statements.deleteSettings.run(chatId)
      statements.deleteDrafts.run(chatId)
      statements.deleteCard.run(chatId)
    },
    moveChat(fromChatId, toChatId) {
      const settingsRow = statements.getSettings.get(fromChatId)
      const drafts = statements.draftsForChat.all(fromChatId)
      const card = statements.getCard.get(fromChatId)
      db.exec("BEGIN")
      try {
        if (settingsRow) {
          const settings = readSettings(fromChatId, blob(settingsRow.ciphertext))
          statements.deleteSettings.run(fromChatId)
          const payload = encrypt(key, settingsAad(toChatId), settingsJson(settings))
          statements.saveSettings.run(toChatId, payload, Date.now())
        }
        for (const row of drafts) {
          const userId = String(row.user_id)
          const draft = readDraft(fromChatId, userId, blob(row.ciphertext))
          statements.deleteDraft.run(fromChatId, userId)
          statements.saveDraft.run(toChatId, userId, encrypt(key, draftAad(toChatId, userId), JSON.stringify(draft)), draft.expiresAt)
        }
        if (card) {
          statements.deleteCard.run(fromChatId)
          statements.saveCard.run(toChatId, Number(card.message_id))
        }
        db.exec("COMMIT")
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
    getDraft(chatId, userId, at = Date.now()) {
      sweep(at)
      const row = statements.getDraft.get(chatId, userId)
      if (!row) return null
      const draft = readDraft(chatId, userId, blob(row.ciphertext))
      if (draft.expiresAt <= at) {
        statements.deleteDraft.run(chatId, userId)
        return null
      }
      return draft
    },
    saveDraft(chatId, userId, draft) {
      statements.saveDraft.run(chatId, userId, encrypt(key, draftAad(chatId, userId), JSON.stringify(draft)), draft.expiresAt)
    },
    deleteDraft(chatId, userId) {
      statements.deleteDraft.run(chatId, userId)
    },
    getCard(chatId) {
      const row = statements.getCard.get(chatId)
      if (!row) return null
      return Number(row.message_id)
    },
    saveCard(chatId, messageId) {
      statements.saveCard.run(chatId, messageId)
    },
  }
}

function credentialFrom(parsed: { credential?: LinearCredential; linearApiKey?: string }): LinearCredential {
  if (parsed.credential) return parsed.credential
  if (parsed.linearApiKey) return { type: "personal", apiKey: parsed.linearApiKey }
  throw new Error("missing linear credential")
}

function settingsJson(settings: ChatSettings): string {
  return JSON.stringify({
    credential: settings.credential,
    teamId: settings.teamId,
    teamKey: settings.teamKey,
    projectId: settings.projectId,
    projectName: settings.projectName,
    assigneeMap: [...settings.assigneeMap],
  })
}

function blob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  throw new DecryptError()
}
