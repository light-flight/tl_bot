import { existsSync } from "node:fs"
import { serve } from "@hono/node-server"
import { webhookCallback } from "grammy"
import { Hono } from "hono"
import { createBot } from "./bot.js"
import { loadConfig } from "./config.js"
import { LinearGateway } from "./linear.js"

if (existsSync(".env")) process.loadEnvFile(".env")

const config = loadConfig(process.env)
const linear = await LinearGateway.connect(config)
const bot = createBot({ token: config.telegramBotToken, linear })
const app = new Hono()

app.get("/up", (c) => c.text("ok"))
app.post("/telegram/webhook", webhookCallback(bot, "hono", { secretToken: config.webhookSecret }))

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Listening on :${info.port}`)
})

await bot.api.setWebhook(config.webhookUrl, {
  secret_token: config.webhookSecret,
  allowed_updates: ["message"],
})
console.log(`Webhook set to ${config.webhookUrl}`)

const shutdown = () => {
  server.close()
  process.exit(0)
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
