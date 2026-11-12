import { existsSync } from "node:fs"
import { serve } from "@hono/node-server"
import { webhookCallback } from "grammy"
import { Hono } from "hono"
import { createBot } from "./bot.js"
import { loadConfig } from "./config.js"
import { asRaw, registerCommands } from "./ephemeral.js"
import { GatewayPool } from "./linear.js"
import { openStore } from "./store.js"

if (existsSync(".env")) process.loadEnvFile(".env")

const config = loadConfig(process.env)
const store = openStore(config.databasePath, config.settingsKey)
const pool = new GatewayPool()
const bot = createBot({ token: config.telegramBotToken, store, pool })
const app = new Hono()

app.get("/up", (c) => c.text("ok"))
app.post("/telegram/webhook", webhookCallback(bot, "hono", { secretToken: config.webhookSecret }))

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Listening on :${info.port}`)
})

await bot.api.setWebhook(config.webhookUrl, {
  secret_token: config.webhookSecret,
  allowed_updates: ["message", "callback_query", "my_chat_member"],
})
await registerCommands(asRaw(bot.api))
console.log(`Webhook set to ${config.webhookUrl}`)

const shutdown = () => {
  server.close()
  store.close()
  process.exit(0)
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
