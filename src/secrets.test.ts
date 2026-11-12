import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { containsLinearKey, decodeSettingsKey, decrypt, DecryptError, encrypt, scrubSecrets } from "./secrets.js"

const key = randomBytes(32)

describe("encrypt", () => {
  it("roundtrips and hides the plaintext", () => {
    const payload = encrypt(key, "chat:-100", "lin_api_SUPERSECRET")

    expect(payload.includes(Buffer.from("lin_api_SUPERSECRET"))).toBe(false)
    expect(decrypt(key, "chat:-100", payload)).toBe("lin_api_SUPERSECRET")
  })

  it("rejects a different aad and a flipped byte", () => {
    const payload = encrypt(key, "chat:-100", "lin_api_SUPERSECRET")

    expect(() => decrypt(key, "chat:-200", payload)).toThrow(DecryptError)
    const tampered = Buffer.from(payload)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
    expect(() => decrypt(key, "chat:-100", tampered)).toThrow(DecryptError)
  })
})

describe("decodeSettingsKey", () => {
  it("requires 32 decoded bytes", () => {
    expect(decodeSettingsKey(key.toString("base64"))).toEqual(key)
    expect(() => decodeSettingsKey("short")).toThrow(/32 bytes/)
  })
})

describe("scrubSecrets", () => {
  it("removes linear keys and detects them", () => {
    expect(scrubSecrets("rejected lin_api_SUPERSECRET now")).toBe("rejected lin_api_[redacted] now")
    expect(containsLinearKey("see lin_api_abc")).toBe(true)
    expect(containsLinearKey("no key here")).toBe(false)
  })
})
