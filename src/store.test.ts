import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { encrypt } from "./secrets.js"
import type { ChatSettings, SetupDraft } from "./settings.js"
import { openStore, type SettingsStore } from "./store.js"

const key = randomBytes(32)
const directories: string[] = []

function settings(apiKey = "lin_api_SUPERSECRET"): ChatSettings {
  return {
    linearApiKey: apiKey,
    teamId: "team-1",
    teamKey: "TL",
    projectId: "project-1",
    projectName: "Сайт",
    assigneeMap: new Map([["georgy", "georgy@example.com"]]),
  }
}

function draft(nonce = "abcd1234"): SetupDraft {
  return {
    nonce,
    expiresAt: Date.now() + 60_000,
    step: "team",
    intent: "setup",
    apiKey: "lin_api_SUPERSECRET",
    assigneeMap: [],
  }
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "tl-bot-"))
  directories.push(directory)
  return join(directory, "settings.sqlite")
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("openStore", () => {
  it("roundtrips settings without writing the key in plaintext", () => {
    const path = databasePath()
    const store = openStore(path, key)
    store.save("-100", settings())
    store.close()

    const db = new DatabaseSync(path)
    const row = db.prepare("SELECT ciphertext FROM chat_settings").get() as { ciphertext: Uint8Array } | undefined
    db.close()
    expect(row).toBeDefined()
    expect(Buffer.from(row?.ciphertext ?? new Uint8Array()).includes(Buffer.from("lin_api_SUPERSECRET"))).toBe(false)

    const reopened = openStore(path, key)
    expect(reopened.get("-100")).toEqual(settings())
    reopened.close()
  })

  it("refuses to start when the encryption key does not match", () => {
    const path = databasePath()
    const store = openStore(path, key)
    store.save("-100", settings())
    store.close()

    expect(() => openStore(path, randomBytes(32))).toThrow(/SETTINGS_KEY does not match/)
  })

  it("moves a chat and forgets the previous id", () => {
    const store = openStore(":memory:", key)
    store.save("-1", settings())
    store.saveCard("-1", 42)
    store.saveDraft("-1", "7", draft())

    store.moveChat("-1", "-100")

    expect(store.get("-1")).toBeNull()
    expect(store.get("-100")).toEqual(settings())
    expect(store.getCard("-100")).toBe(42)
    expect(store.getDraft("-100", "7")?.nonce).toBe("abcd1234")
    expect(store.getDraft("-1", "7")).toBeNull()
    store.close()
  })

  it("forgets settings, drafts and the card when the bot leaves", () => {
    const store = openStore(":memory:", key)
    store.save("-100", settings())
    store.saveCard("-100", 5)
    store.saveDraft("-100", "7", draft())

    store.forgetChat("-100")

    expect(store.get("-100")).toBeNull()
    expect(store.getCard("-100")).toBeNull()
    expect(store.getDraft("-100", "7")).toBeNull()
    store.close()
  })

  it("drops an expired draft", () => {
    const store = openStore(":memory:", key)
    store.saveDraft("-100", "7", { ...draft(), expiresAt: 1_000 })

    expect(store.getDraft("-100", "7", 1_001)).toBeNull()
    store.close()
  })

  it("drops a corrupt draft and still opens saved settings", () => {
    const path = databasePath()
    const store = openStore(path, key)
    store.save("-100", settings())
    store.close()

    const db = new DatabaseSync(path)
    db.prepare("INSERT INTO setup_drafts (chat_id, user_id, ciphertext, expires_at) VALUES (?, ?, ?, ?)").run(
      "-100",
      "7",
      randomBytes(32),
      Date.now() + 60_000,
    )
    db.close()

    const reopened = openStore(path, key)
    expect(reopened.get("-100")?.teamKey).toBe("TL")
    expect(reopened.getDraft("-100", "7")).toBeNull()
    reopened.close()
  })
})

describe("draft aad", () => {
  it("cannot be read as another chat", () => {
    const payload = encrypt(key, "draft:-100:7", JSON.stringify(draft()))
    const path = databasePath()
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE setup_drafts (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE TABLE chat_settings (
        chat_id TEXT PRIMARY KEY,
        ciphertext BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE chat_cards (
        chat_id TEXT PRIMARY KEY,
        message_id INTEGER NOT NULL
      );
    `)
    db.prepare("INSERT INTO setup_drafts (chat_id, user_id, ciphertext, expires_at) VALUES (?, ?, ?, ?)").run(
      "-200",
      "7",
      payload,
      Date.now() + 60_000,
    )
    db.close()

    const store: SettingsStore = openStore(path, key)
    expect(store.getDraft("-200", "7")).toBeNull()
    store.close()
  })
})
