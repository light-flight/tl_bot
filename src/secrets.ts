import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_PATTERN = /lin_api_[A-Za-z0-9_]+/g

export class DecryptError extends Error {
  constructor() {
    super("Failed to decrypt")
    this.name = "DecryptError"
  }
}

export function decodeSettingsKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64")
  if (key.length !== 32) {
    throw new Error("Invalid configuration: SETTINGS_KEY: must decode to 32 bytes")
  }
  return key
}

export function encrypt(key: Buffer, aad: string, plaintext: string): Buffer {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes")
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(aad, "utf8"))
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, data])
}

export function decrypt(key: Buffer, aad: string, payload: Buffer): string {
  if (key.length !== 32 || payload.length < IV_LENGTH + TAG_LENGTH) throw new DecryptError()
  const iv = payload.subarray(0, IV_LENGTH)
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const data = payload.subarray(IV_LENGTH + TAG_LENGTH)
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAAD(Buffer.from(aad, "utf8"))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
  } catch {
    throw new DecryptError()
  }
}

export function containsLinearKey(text: string): boolean {
  KEY_PATTERN.lastIndex = 0
  return KEY_PATTERN.test(text)
}

export function scrubSecrets(text: string): string {
  return text.replace(KEY_PATTERN, "lin_api_[redacted]")
}
