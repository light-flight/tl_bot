import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchTeams, GatewayPool, probeKey, settingsFingerprint, type LinearGateway } from "./linear.js"
import type { ChatSettings, LinearCredential } from "./settings.js"

const linearState = vi.hoisted(() => ({
  failuresLeft: 0,
  calls: 0,
  clients: [] as { apiKey?: string; accessToken?: string }[],
  thrown: "",
}))

vi.mock("@linear/sdk", () => {
  class LinearClient {
    constructor(options: { apiKey?: string; accessToken?: string }) {
      linearState.clients.push(options)
    }

    async teams() {
      linearState.calls += 1
      if (linearState.failuresLeft > 0) {
        linearState.failuresLeft -= 1
        const token = linearState.clients.at(-1)?.accessToken ?? ""
        throw Object.assign(new Error(linearState.thrown || `unauthorized ${token}`), { status: 401 })
      }
      return { nodes: [{ id: "team-1", key: "TL", name: "Team" }], pageInfo: { hasNextPage: false } }
    }
  }
  return { LinearClient }
})

function settings(apiKey: string): ChatSettings {
  return {
    credential: { type: "personal", apiKey },
    teamId: "team-1",
    teamKey: "TL",
    projectId: null,
    projectName: null,
    assigneeMap: new Map(),
  }
}

function app(clientId: string, clientSecret: string): LinearCredential {
  return { type: "app", clientId, clientSecret }
}

function stubToken(input?: { status?: number; expiresIn?: number; token?: string; fail?: boolean }) {
  const requests: { url: string; body: string }[] = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), body: String(init?.body ?? "") })
    if (input?.fail) throw new TypeError("fetch failed")
    const status = input?.status ?? 200
    if (status !== 200) return new Response(`denied ${requests.length}`, { status })
    return new Response(
      JSON.stringify({ access_token: input?.token ?? "app-token", expires_in: input?.expiresIn ?? 2_592_000 }),
      { status: 200 },
    )
  })
  return requests
}

afterEach(() => {
  linearState.failuresLeft = 0
  linearState.calls = 0
  linearState.clients = []
  linearState.thrown = ""
  vi.unstubAllGlobals()
})

describe("GatewayPool", () => {
  it("reuses a client until the chat settings change", async () => {
    const opened: string[] = []
    const pool = new GatewayPool(async (value) => {
      if (value.credential.type !== "personal") throw new Error("expected a personal key")
      opened.push(value.credential.apiKey)
      return { opened: opened.length } as unknown as LinearGateway
    })

    const first = settings("lin_api_one")
    expect(await pool.forChat("-100", first)).toBe(await pool.forChat("-100", first))
    expect(opened).toEqual(["lin_api_one"])

    pool.drop("-100")
    await pool.forChat("-100", first)
    expect(opened).toEqual(["lin_api_one", "lin_api_one"])

    await pool.forChat("-100", settings("lin_api_two"))
    expect(opened).toEqual(["lin_api_one", "lin_api_one", "lin_api_two"])
  })
})

describe("settingsFingerprint", () => {
  it("does not contain the api key", () => {
    expect(settingsFingerprint(settings("lin_api_SUPERSECRET"))).not.toContain("SUPERSECRET")
    const fingerprint = settingsFingerprint({
      ...settings("lin_api_other"),
      credential: { type: "app", clientId: "client-id", clientSecret: "secretvalue" },
    })
    expect(fingerprint).not.toContain("secretvalue")
  })
})

describe("application credentials", () => {
  it("exchanges a client secret for a token and reuses it", async () => {
    const requests = stubToken()
    const credential = app("client-id-a", "secret-value-a")

    expect(await fetchTeams(credential)).toEqual([{ id: "team-1", key: "TL", name: "Team" }])
    expect(await fetchTeams(credential)).toEqual([{ id: "team-1", key: "TL", name: "Team" }])

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://api.linear.app/oauth/token")
    expect(requests[0]?.url).not.toContain("secret-value-a")
    expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toMatchObject({
      grant_type: "client_credentials",
      scope: "read,write",
      client_id: "client-id-a",
      client_secret: "secret-value-a",
    })
    expect(linearState.clients.map((client) => client.accessToken)).toEqual(["app-token", "app-token"])
  })

  it("fetches a new token within a day of expiry", async () => {
    const requests = stubToken({ expiresIn: 60, token: "short-token" })
    const credential = app("client-id-b", "secret-value-b")

    await fetchTeams(credential)
    await fetchTeams(credential)

    expect(requests).toHaveLength(2)
  })

  it("retries an application request once after 401 and drops the token from the error", async () => {
    stubToken({ token: "app-token-secret" })
    linearState.failuresLeft = 1
    const credential = app("client-id-c", "secret-value-c")

    await expect(fetchTeams(credential)).resolves.toEqual([{ id: "team-1", key: "TL", name: "Team" }])
    expect(linearState.calls).toBe(2)
    expect(linearState.clients.map((client) => client.accessToken)).toEqual(["app-token-secret", "app-token-secret"])
  })

  it("does not retry a personal key and does not call the token endpoint", async () => {
    const requests = stubToken()
    linearState.failuresLeft = 1

    await expect(fetchTeams({ type: "personal", apiKey: "lin_api_SUPERSECRET" })).rejects.toThrow(/unauthorized/)
    expect(linearState.calls).toBe(1)
    expect(requests).toHaveLength(0)
    expect(linearState.clients).toEqual([{ apiKey: "lin_api_SUPERSECRET" }])
  })

  it("reports a rejected application secret without repeating it", async () => {
    stubToken({ status: 401 })
    const result = await probeKey(app("client-id-d", "secret-value-d"))

    expect(result).toEqual({ ok: false, unauthorized: true })
  })

  it("reports a network failure separately from a rejected secret", async () => {
    stubToken({ fail: true })

    await expect(probeKey(app("client-id-e", "secret-value-e"))).resolves.toEqual({ ok: false, unauthorized: false })
  })

  it("removes the access token and client secret from a repeated auth failure", async () => {
    stubToken({ token: "app-token-secret" })
    linearState.failuresLeft = 2
    linearState.thrown = "rejected app-token-secret and secret-value-f"

    await expect(fetchTeams(app("client-id-f", "secret-value-f"))).rejects.toThrow(
      "rejected [redacted] and [redacted]",
    )
  })
})
