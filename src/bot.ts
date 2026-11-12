import { Bot, type Context } from "grammy"
import { messageLinkTitle, telegramMessageLink } from "./description.js"
import {
  asRaw,
  deleteEphemeral,
  deletePlain,
  editEphemeral,
  ephemeralId,
  inlineKeyboard,
  receiverId,
  sendEphemeral,
} from "./ephemeral.js"
import { issueDescription, runMention } from "./issue-flow.js"
import {
  cleanError,
  fetchProjects,
  fetchTeams,
  fetchUsers,
  probeKey,
  type GatewayPool,
  type LinearProject,
  type LinearTeam,
} from "./linear.js"
import { containsLinearKey } from "./secrets.js"
import {
  ADMIN_ONLY,
  acceptWizardCallback,
  assigneeButtons,
  assigneePrompt,
  AUTH_FAILURE,
  CHECKING_KEY,
  confirmResetButtons,
  confirmResetText,
  connectedCard,
  DISCONNECTED,
  GENERIC_FAILURE,
  KEY_FORMAT,
  KEY_RATE_LIMIT,
  KEY_REJECTED,
  KEY_UNREACHABLE,
  keyDecision,
  keyStepText,
  LEAK_WARNING,
  LOAD_FAILED,
  NO_TEAMS,
  NOT_HIDDEN,
  onboardingCard,
  parseWizardData,
  PRIVATE_HINT,
  projectButtons,
  projectPrompt,
  settingsButtons,
  settingsText,
  setupCard,
  startSetup,
  teamButtons,
  teamPrompt,
  toSettings,
  touch,
  validateAssignees,
  withAssignees,
  withKey,
  withProject,
  withTeam,
  ASSIGNEE_HELP,
  draftFromSettings,
  createDraft,
  type Button,
  type WizardAction,
} from "./setup.js"
import { type ChatSettings, type SetupDraft } from "./settings.js"
import type { SettingsStore } from "./store.js"
import { parseMessage, type TextEntity } from "./parse-message.js"

const DEDUPE_TTL_MS = 10 * 60 * 1000
const ADMIN_TTL_MS = 60 * 1000
const KEY_WINDOW_MS = 10 * 60 * 1000
const KEY_LIMIT = 5

type Seen = {
  begin: (chatId: number, messageId: number) => boolean
  forget: (chatId: number, messageId: number) => void
}

export function createBot(deps: { token: string; store: SettingsStore; pool: GatewayPool; now?: () => number }): Bot {
  const bot = new Bot(deps.token)
  const now = deps.now ?? Date.now
  const seen = createSeen()
  const adminCache = new Map<string, { at: number; ok: boolean }>()
  const keyAttempts = new Map<string, number[]>()

  const clock = () => now()

  const isAdmin = async (chatId: number, userId: number, senderChatId?: number): Promise<boolean> => {
    if (senderChatId === chatId) return true
    const cacheKey = `${chatId}:${userId}`
    const cached = adminCache.get(cacheKey)
    const at = clock()
    if (cached && at - cached.at < ADMIN_TTL_MS) return cached.ok
    try {
      const member = await bot.api.getChatMember(chatId, userId)
      const ok = member.status === "creator" || member.status === "administrator"
      adminCache.set(cacheKey, { at, ok })
      return ok
    } catch (error) {
      console.error("Failed to check chat admin", cleanError(error))
      return false
    }
  }

  const allowKey = (userId: number): boolean => {
    const at = clock()
    const recent = (keyAttempts.get(String(userId)) ?? []).filter((attempt) => at - attempt < KEY_WINDOW_MS)
    if (recent.length >= KEY_LIMIT) {
      keyAttempts.set(String(userId), recent)
      return false
    }
    recent.push(at)
    keyAttempts.set(String(userId), recent)
    return true
  }

  const commit = (chatId: string, settings: ChatSettings) => {
    deps.store.save(chatId, settings)
    deps.pool.drop(chatId)
  }

  const publishCard = async (chatId: number, text: string, buttons: Button[][]) => {
    const raw = asRaw(bot.api)
    const markup = inlineKeyboard(buttons)
    const existing = deps.store.getCard(String(chatId))
    if (existing) {
      try {
        await raw.editMessageText({
          chat_id: chatId,
          message_id: existing,
          text,
          reply_markup: markup ?? { inline_keyboard: [] },
        })
        return
      } catch (error) {
        console.error("Failed to edit onboarding card", cleanError(error))
      }
    }
    const sent = await raw.sendMessage({
      chat_id: chatId,
      text,
      ...(markup ? { reply_markup: markup } : {}),
    })
    const messageId = sent.message_id
    if (typeof messageId === "number" && messageId > 0) deps.store.saveCard(String(chatId), messageId)
  }

  const present = async (
    chatId: number,
    userId: number,
    draft: SetupDraft,
    text: string,
    buttons: Button[][],
    delivery?: { replyTo?: number; callbackQueryId?: string; replace?: boolean; threadId?: number },
  ): Promise<SetupDraft> => {
    const raw = asRaw(bot.api)
    if (draft.ephemeralMessageId !== undefined) {
      try {
        await editEphemeral(raw, { chatId, userId, ephemeralMessageId: draft.ephemeralMessageId, text, buttons })
        return draft
      } catch (error) {
        console.error("Failed to edit setup message", cleanError(error))
      }
    }
    const id = await sendEphemeral(raw, {
      chatId,
      userId,
      text,
      buttons,
      ...(delivery?.threadId !== undefined ? { threadId: delivery.threadId } : {}),
      ...(delivery?.replyTo !== undefined ? { replyToEphemeralId: delivery.replyTo } : {}),
      ...(delivery?.callbackQueryId ? { callbackQueryId: delivery.callbackQueryId } : {}),
      ...(delivery?.replace ? { replaceCallbackMessage: true } : {}),
    })
    return id === undefined ? draft : { ...draft, ephemeralMessageId: id }
  }

  const remember = (chatId: string, userId: number, draft: SetupDraft) => {
    deps.store.saveDraft(chatId, String(userId), draft)
  }

  const showTeams = async (
    chatId: number,
    userId: number,
    draft: SetupDraft,
    teams: LinearTeam[],
    delivery?: { replyTo?: number; threadId?: number },
  ) => {
    const text = teams.length === 0 ? NO_TEAMS : teamPrompt(draft.intent)
    const buttons = teams.length === 0 ? [] : teamButtons(draft.nonce, teams, 0)
    const next = await present(chatId, userId, draft, text, buttons, delivery)
    remember(String(chatId), userId, next)
  }

  const showProjects = async (chatId: number, userId: number, draft: SetupDraft, projects: LinearProject[]) => {
    const next = await present(
      chatId,
      userId,
      draft,
      projectPrompt(draft.intent, draft.teamKey ?? ""),
      projectButtons(draft.nonce, projects, 0),
    )
    remember(String(chatId), userId, next)
  }

  const showAssignees = async (
    chatId: number,
    userId: number,
    draft: SetupDraft,
    lines: string[],
    delivery?: { replyTo?: number; threadId?: number },
  ) => {
    const next = await present(
      chatId,
      userId,
      draft,
      assigneePrompt(draft.teamKey ?? "", draft.projectName ?? null, lines),
      assigneeButtons(draft.nonce),
      delivery,
    )
    remember(String(chatId), userId, next)
  }

  const showSettings = async (chatId: number, userId: number, draft: SetupDraft, settings: ChatSettings) => {
    const next = await present(chatId, userId, draft, settingsText(settings), settingsButtons(draft.nonce))
    remember(String(chatId), userId, next)
  }

  const finishSetup = async (chatId: number, userId: number, draft: SetupDraft) => {
    const settings = toSettings(draft)
    if (!settings) {
      const next = await present(chatId, userId, draft, "Сначала выберите команду.", [])
      remember(String(chatId), userId, next)
      return
    }
    commit(String(chatId), settings)
    deps.store.deleteDraft(String(chatId), String(userId))
    const card = connectedCard(settings, false)
    await publishCard(chatId, card.text, card.buttons)
    await present(chatId, userId, draft, `Готово.\n${settingsText(settings)}`, [])
  }

  const disconnect = async (chatId: number) => {
    const cardId = deps.store.getCard(String(chatId))
    deps.store.forgetChat(String(chatId))
    deps.pool.drop(String(chatId))
    if (cardId !== null) deps.store.saveCard(String(chatId), cardId)
    const card = setupCard()
    await publishCard(chatId, card.text, card.buttons)
    await asRaw(bot.api).sendMessage({ chat_id: chatId, text: DISCONNECTED })
  }

  bot.command("start", async (ctx) => {
    if (ctx.chat?.type !== "private") return
    await ctx.reply(
      [
        "Добавьте меня в группу и отметьте, чтобы создать задачу.",
        "Первая строка — название, дальше описание.",
        "Чтобы назначить исполнителя, отметьте его в том же сообщении.",
        "Команда, проект и ключ Linear задаются в группе кнопкой «Настроить».",
      ].join("\n"),
    )
  })

  bot.on("my_chat_member", async (ctx) => {
    const update = ctx.myChatMember
    if (!update) return
    const chat = update.chat
    if (chat.type !== "group" && chat.type !== "supergroup") return
    const chatId = String(chat.id)
    const previous = update.old_chat_member.status
    const next = update.new_chat_member.status
    const wasOut = previous === "left" || previous === "kicked"
    if (next === "left" || next === "kicked") {
      deps.store.forgetChat(chatId)
      deps.pool.drop(chatId)
      return
    }
    if (!wasOut) return
    if (next !== "member" && next !== "administrator" && next !== "restricted") return
    const card = onboardingCard(deps.store.get(chatId))
    await publishCard(chat.id, card.text, card.buttons)
  })

  bot.on("message:migrate_to_chat_id", (ctx) => {
    const next = ctx.msg?.migrate_to_chat_id
    if (!ctx.chat || next === undefined) return
    const from = String(ctx.chat.id)
    deps.store.moveChat(from, String(next))
    deps.pool.drop(from)
    deps.pool.drop(String(next))
  })

  bot.on("callback_query:data", async (ctx) => {
    const chat = ctx.chat
    const from = ctx.from
    if (!chat || !from || !isGroup(chat)) {
      await ctx.answerCallbackQuery()
      return
    }
    const data = ctx.callbackQuery.data
    const senderChatId = callbackSenderChat(ctx)
    if (data === "onboard" || data === "edit") {
      await onOnboardingButton(ctx, chat.id, from.id, data, senderChatId)
      return
    }
    const parsed = parseWizardData(data)
    if (!parsed) {
      await ctx.answerCallbackQuery()
      return
    }
    await onWizardAction(ctx, chat.id, from.id, parsed.nonce, parsed.action, senderChatId)
  })

  bot.command("setup", async (ctx) => {
    if (!ctx.chat || !ctx.from) return
    if (!isGroup(ctx.chat)) {
      await ctx.reply(PRIVATE_HINT)
      return
    }
    if (ephemeralId(ctx.msg) === undefined) {
      await ctx.reply(NOT_HIDDEN)
      return
    }
    if (!(await isAdmin(ctx.chat.id, ctx.from.id, ctx.msg?.sender_chat?.id))) {
      await replyHidden(ctx, ADMIN_ONLY)
      return
    }
    const started = startSetup({ isAdmin: true, now: clock() })
    if (!started.ok) return
    const draft = await present(ctx.chat.id, ctx.from.id, started.draft, keyStepText(), [], {
      replyTo: ephemeralId(ctx.msg),
      threadId: ctx.msg?.message_thread_id,
    })
    remember(String(ctx.chat.id), ctx.from.id, draft)
  })

  bot.command("cancel", async (ctx) => {
    if (!ctx.chat || !ctx.from || !isGroup(ctx.chat)) {
      if (ctx.chat?.type === "private") await ctx.reply(PRIVATE_HINT)
      return
    }
    deps.store.deleteDraft(String(ctx.chat.id), String(ctx.from.id))
    const text = "Настройка отменена."
    if (ephemeralId(ctx.msg) === undefined) await ctx.reply(text)
    else await replyHidden(ctx, text)
  })

  bot.command("settings", async (ctx) => {
    if (!ctx.chat || !ctx.from) return
    if (!isGroup(ctx.chat)) {
      await ctx.reply(PRIVATE_HINT)
      return
    }
    const settings = deps.store.get(String(ctx.chat.id))
    if (ephemeralId(ctx.msg) === undefined) {
      const card = onboardingCard(settings)
      await sendCardReply(ctx, card.text, card.buttons)
      return
    }
    if (!(await isAdmin(ctx.chat.id, ctx.from.id, ctx.msg?.sender_chat?.id))) {
      await replyHidden(ctx, ADMIN_ONLY)
      return
    }
    if (!settings) {
      const started = startSetup({ isAdmin: true, now: clock() })
      if (!started.ok) return
      const draft = await present(ctx.chat.id, ctx.from.id, started.draft, keyStepText(), [], {
        replyTo: ephemeralId(ctx.msg),
        threadId: ctx.msg?.message_thread_id,
      })
      remember(String(ctx.chat.id), ctx.from.id, draft)
      return
    }
    const seeded = draftFromSettings(settings, clock(), "manage", "settings")
    const shown = await present(ctx.chat.id, ctx.from.id, seeded, settingsText(settings), settingsButtons(seeded.nonce), {
      replyTo: ephemeralId(ctx.msg),
      threadId: ctx.msg?.message_thread_id,
    })
    remember(String(ctx.chat.id), ctx.from.id, shown)
  })

  bot.command("key", async (ctx) => {
    await onKey(ctx)
  })

  bot.command("assignees", async (ctx) => {
    await onAssignees(ctx)
  })

  bot.on(["message:text", "message:caption"], async (ctx) => {
    const message = ctx.msg
    if (!message || !ctx.chat) return
    const text = message.text ?? message.caption ?? ""
    const entities = message.entities ?? message.caption_entities ?? []
    if (entities.some((entity) => entity.type === "bot_command" && entity.offset === 0)) return

    if (ctx.chat.type === "private" && containsLinearKey(text)) {
      await deletePlain(asRaw(ctx.api), ctx.chat.id, message.message_id)
      await ctx.reply("Ключ не сохранён. Настройка делается в группе кнопкой «Настроить».")
      return
    }

    if (!isGroup(ctx.chat)) return
    if (publicSecret(text, ephemeralId(message) !== undefined)) {
      await deletePlain(asRaw(ctx.api), ctx.chat.id, message.message_id)
      await ctx.reply(LEAK_WARNING)
      return
    }
    await handleMention(ctx, seen)
  })

  bot.catch((error) => {
    console.error("Telegram handler failed", cleanError(error.error))
  })

  return bot

  async function onOnboardingButton(
    ctx: Context,
    chatId: number,
    userId: number,
    data: string,
    senderChatId: number | undefined,
  ) {
    if (!(await isAdmin(chatId, userId, senderChatId))) {
      await ctx.answerCallbackQuery({ text: ADMIN_ONLY, show_alert: true })
      return
    }
    await ctx.answerCallbackQuery()
    const message = ctx.callbackQuery?.message
    const receiver = message ? receiverId(message) : undefined
    if (receiver !== undefined && receiver !== userId) return

    if (data === "edit") {
      const settings = deps.store.get(String(chatId))
      if (!settings) {
        await openKeyStep(ctx, chatId, userId)
        return
      }
      const seeded = draftFromSettings(settings, clock(), "manage", "settings")
      const draft = await present(chatId, userId, seeded, settingsText(settings), settingsButtons(seeded.nonce), {
        callbackQueryId: ctx.callbackQuery?.id,
        replace: true,
      })
      remember(String(chatId), userId, draft)
      return
    }
    await openKeyStep(ctx, chatId, userId)
  }

  async function openKeyStep(ctx: Context, chatId: number, userId: number) {
    const started = startSetup({ isAdmin: true, now: clock() })
    if (!started.ok) return
    try {
      const draft = await present(chatId, userId, started.draft, keyStepText(), [], {
        callbackQueryId: ctx.callbackQuery?.id,
        replace: true,
      })
      remember(String(chatId), userId, draft)
    } catch (error) {
      console.error("Failed to open setup", cleanError(error))
      await asRaw(ctx.api).sendMessage({
        chat_id: chatId,
        text: "Не получилось открыть скрытую настройку. Обновите Telegram и нажмите «Настроить» ещё раз.",
      })
    }
  }

  async function onWizardAction(
    ctx: Context,
    chatId: number,
    userId: number,
    nonce: string,
    action: WizardAction,
    senderChatId: number | undefined,
  ) {
    const message = ctx.callbackQuery?.message
    const receiver = message ? receiverId(message) : undefined
    if (receiver !== undefined && receiver !== userId) {
      await ctx.answerCallbackQuery()
      return
    }
    const draft = deps.store.getDraft(String(chatId), String(userId), clock())
    if (!acceptWizardCallback(draft, nonce, clock())) {
      await ctx.answerCallbackQuery()
      return
    }
    if (!(await isAdmin(chatId, userId, senderChatId))) {
      await ctx.answerCallbackQuery({ text: ADMIN_ONLY, show_alert: true })
      return
    }
    await ctx.answerCallbackQuery()
    if (message && ephemeralId(message) !== undefined) draft.ephemeralMessageId = ephemeralId(message)

    try {
      await applyAction(chatId, userId, draft, action)
    } catch (error) {
      console.error("Failed to apply setup action", cleanError(error))
      const next = await present(chatId, userId, draft, LOAD_FAILED, [])
      remember(String(chatId), userId, next)
    }
  }

  async function applyAction(chatId: number, userId: number, draft: SetupDraft, action: WizardAction) {
    if (action.type === "teams" || action.type === "team" || action.type === "edit-team") {
      if (!draft.credential) {
        const next = await present(chatId, userId, draft, keyStepText(), [])
        remember(String(chatId), userId, next)
        return
      }
      const teams = await fetchTeams(draft.credential)
      if (action.type === "edit-team") {
        const next = touch({ ...draft, intent: "retarget", step: "team" }, clock())
        await showTeams(chatId, userId, next, teams)
        return
      }
      if (action.type === "teams") {
        const next = await present(chatId, userId, draft, teamPrompt(draft.intent), teamButtons(draft.nonce, teams, action.page))
        remember(String(chatId), userId, next)
        return
      }
      const team = teams.find((item) => item.id === action.id)
      if (!team) {
        const next = await present(chatId, userId, draft, "Команда не найдена.", teamButtons(draft.nonce, teams, 0))
        remember(String(chatId), userId, next)
        return
      }
      const chosen = withTeam(draft, team, clock())
      const projects = await fetchProjects(draft.credential, team.id)
      await showProjects(chatId, userId, chosen, projects)
      return
    }

    if (action.type === "projects" || action.type === "project" || action.type === "no-project" || action.type === "edit-project") {
      if (!draft.credential || !draft.teamId) {
        const next = await present(chatId, userId, draft, "Сначала выберите команду.", [])
        remember(String(chatId), userId, next)
        return
      }
      const projects = await fetchProjects(draft.credential, draft.teamId)
      if (action.type === "edit-project") {
        const next = touch({ ...draft, intent: "reproject", step: "project" }, clock())
        await showProjects(chatId, userId, next, projects)
        return
      }
      if (action.type === "projects") {
        const next = await present(
          chatId,
          userId,
          draft,
          projectPrompt(draft.intent, draft.teamKey ?? ""),
          projectButtons(draft.nonce, projects, action.page),
        )
        remember(String(chatId), userId, next)
        return
      }
      const project = action.type === "project" ? projects.find((item) => item.id === action.id) : null
      if (action.type === "project" && !project) {
        const next = await present(chatId, userId, draft, "Проект не найден.", projectButtons(draft.nonce, projects, 0))
        remember(String(chatId), userId, next)
        return
      }
      const chosen = withProject(draft, project ?? null, clock())
      if (chosen.intent === "setup") {
        await showAssignees(chatId, userId, chosen, [])
        return
      }
      const settings = toSettings(chosen)
      if (!settings) return
      commit(String(chatId), settings)
      const managed = {
        ...draftFromSettings(settings, clock(), "manage", "settings"),
        nonce: draft.nonce,
        ephemeralMessageId: chosen.ephemeralMessageId,
      }
      await showSettings(chatId, userId, managed, settings)
      const card = connectedCard(settings, false)
      await publishCard(chatId, card.text, card.buttons)
      return
    }

    if (action.type === "no-map" || action.type === "done") {
      if (draft.intent !== "setup") return
      const chosen = action.type === "no-map" ? withAssignees(draft, new Map(), clock()) : draft
      await finishSetup(chatId, userId, chosen)
      return
    }

    if (action.type === "reset") {
      const next = touch({ ...draft, step: "confirm-reset" }, clock())
      const shown = await present(chatId, userId, next, confirmResetText(), confirmResetButtons(next.nonce))
      remember(String(chatId), userId, shown)
      return
    }

    if (action.type === "reset-yes") {
      if (draft.step !== "confirm-reset") return
      await disconnect(chatId)
    }
  }

  async function onKey(ctx: Context) {
    if (!ctx.chat || !ctx.from) return
    const text = ctx.msg?.text ?? ""
    const argument = String(ctx.match ?? "").trim()
    if (!isGroup(ctx.chat)) {
      if (containsLinearKey(text) || argument) await deletePlain(asRaw(ctx.api), ctx.chat.id, ctx.msg?.message_id ?? 0)
      await ctx.reply(PRIVATE_HINT)
      return
    }
    const decision = keyDecision({ ephemeral: ephemeralId(ctx.msg) !== undefined, argument: String(ctx.match ?? "") })
    if (decision.type === "not-hidden") {
      if (argument) await deletePlain(asRaw(ctx.api), ctx.chat.id, ctx.msg?.message_id ?? 0)
      await ctx.reply(NOT_HIDDEN)
      return
    }

    const chatId = ctx.chat.id
    const userId = ctx.from.id
    const incoming = ephemeralId(ctx.msg)
    const delivery = { replyTo: incoming, threadId: ctx.msg?.message_thread_id }
    const existing = deps.store.getDraft(String(chatId), String(userId), clock())
    let draft = existing ?? createDraft(clock(), "setup", "key")
    let persisted = existing !== null

    const show = async (message: string, buttons: Button[][] = []) => {
      draft = await present(chatId, userId, draft, message, buttons, delivery)
      if (persisted) remember(String(chatId), userId, draft)
    }

    try {
      if (!(await isAdmin(chatId, userId, ctx.msg?.sender_chat?.id))) {
        await show(ADMIN_ONLY)
        return
      }
      if (decision.type === "empty") {
        await show(keyStepText())
        return
      }
      if (decision.type === "bad-format") {
        await show(KEY_FORMAT)
        return
      }
      if (!allowKey(userId)) {
        await show(KEY_RATE_LIMIT)
        return
      }

      await show(CHECKING_KEY)
      const probe = await probeKey(decision.credential)
      if (!probe.ok) {
        await show(probe.unauthorized ? KEY_REJECTED : KEY_UNREACHABLE)
        return
      }

      const settings = deps.store.get(String(chatId))
      const team = settings ? probe.teams.find((item) => item.id === settings.teamId) : undefined
      if (settings && team) {
        commit(String(chatId), { ...settings, credential: decision.credential })
        if (existing) {
          draft = touch(
            { ...existing, credential: decision.credential, ephemeralMessageId: draft.ephemeralMessageId },
            clock(),
          )
          persisted = true
        }
        await show(`Ключ обновлён. Команда ${team.key} на месте.`)
        return
      }

      draft = withKey(draft, decision.credential, clock())
      await showTeams(chatId, userId, draft, probe.teams, delivery)
    } finally {
      if (incoming !== undefined && incoming !== draft.ephemeralMessageId) {
        await deleteEphemeral(asRaw(ctx.api), chatId, userId, incoming)
      }
    }
  }

  async function onAssignees(ctx: Context) {
    if (!ctx.chat || !ctx.from) return
    if (!isGroup(ctx.chat)) {
      await ctx.reply(PRIVATE_HINT)
      return
    }
    if (ephemeralId(ctx.msg) === undefined) {
      await deletePlain(asRaw(ctx.api), ctx.chat.id, ctx.msg?.message_id ?? 0)
      await ctx.reply(NOT_HIDDEN)
      return
    }
    const chatId = ctx.chat.id
    const userId = ctx.from.id
    const incoming = ephemeralId(ctx.msg)
    const delivery = { replyTo: incoming, threadId: ctx.msg?.message_thread_id }
    try {
      if (!(await isAdmin(chatId, userId, ctx.msg?.sender_chat?.id))) {
        await replyHidden(ctx, ADMIN_ONLY)
        return
      }
      const argument = String(ctx.match ?? "").trim()
      const draft = deps.store.getDraft(String(chatId), String(userId), clock())
      const settings = deps.store.get(String(chatId))
      if (!argument) {
        await replyHidden(ctx, ASSIGNEE_HELP)
        return
      }

      const credential = draft?.credential ?? settings?.credential
      if (!credential) {
        await replyHidden(ctx, keyStepText())
        return
      }
      let users
      try {
        users = await fetchUsers(credential)
      } catch (error) {
        console.error("Failed to load Linear users", cleanError(error))
        await replyHidden(ctx, LOAD_FAILED)
        return
      }
      const check = validateAssignees(argument, users)
      if (!check.ok) {
        if (draft?.intent === "setup") {
          const next = await present(chatId, userId, draft, check.message, assigneeButtons(draft.nonce), delivery)
          remember(String(chatId), userId, next)
        } else {
          await replyHidden(ctx, check.message)
        }
        return
      }

      if (draft?.intent === "setup" || !settings) {
        const base = draft ?? createDraft(clock(), "setup", "assignees")
        await showAssignees(
          chatId,
          userId,
          withAssignees({ ...base, intent: "setup", credential }, check.map, clock()),
          check.lines,
          delivery,
        )
        return
      }

      if (draft) remember(String(chatId), userId, touch({ ...draft, assigneeMap: [...check.map] }, clock()))
      commit(String(chatId), { ...settings, assigneeMap: check.map })
      await replyHidden(ctx, ["Карта обновлена.", ...check.lines].join("\n"))
    } finally {
      if (incoming !== undefined) await deleteEphemeral(asRaw(ctx.api), chatId, userId, incoming)
    }
  }

  async function replyHidden(ctx: Context, text: string) {
    if (!ctx.chat || !ctx.from) return
    const id = ephemeralId(ctx.msg)
    await sendEphemeral(asRaw(ctx.api), {
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      text,
      ...(id !== undefined ? { replyToEphemeralId: id } : {}),
      ...(ctx.msg?.message_thread_id !== undefined ? { threadId: ctx.msg.message_thread_id } : {}),
    })
  }

  async function handleMention(ctx: Context, dedupe: Seen) {
    const chat = ctx.chat
    const message = ctx.msg
    if (!chat || !message || !isGroup(chat)) return
    const text = message.text ?? message.caption
    if (!text) return
    const username = ctx.me.username
    if (!username) return

    const reply = message.reply_to_message
    const parsed = parseMessage({
      text,
      entities: (message.entities ?? message.caption_entities ?? []) as TextEntity[],
      botUsername: username,
      botId: ctx.me.id,
      replyText: reply?.text ?? reply?.caption,
    })
    if (!parsed.botMentioned) return
    if (!dedupe.begin(chat.id, message.message_id)) return

    const settings = deps.store.get(String(chat.id))
    const outcome = await runMention({
      botMentioned: parsed.botMentioned,
      title: parsed.title,
      settings,
      create: async () => {
        if (!settings) throw new Error("Linear is not configured")
        const gateway = await deps.pool.forChat(String(chat.id), settings)
        const resolution = await gateway.resolveAssignees(parsed.mentions)
        return gateway.createIssue({
          title: parsed.title ?? "",
          description: issueDescription({
            body: parsed.body,
            replyText: reply?.text ?? reply?.caption,
            titleSource: parsed.titleSource,
          }),
          messageLink: telegramMessageLink(chat.id, "username" in chat ? chat.username : undefined, message.message_id),
          linkTitle: messageLinkTitle(message.from),
          ...(resolution.assignee ? { assigneeId: resolution.assignee.id } : {}),
        })
      },
    })

    try {
      if (outcome.type === "setup") {
        const card = setupCard()
        await sendCardReply(ctx, card.text, card.buttons)
        return
      }
      if (outcome.type === "need-title") {
        await ctx.reply("Напишите название задачи в той же строке или со следующей.")
        return
      }
      if (outcome.type === "created") {
        await ctx.reply(outcome.text, { entities: outcome.entities })
        return
      }
      if (outcome.type === "failed") {
        console.error("Failed to create Linear issue", outcome.detail)
        dedupe.forget(chat.id, message.message_id)
        await ctx.reply(outcome.auth ? AUTH_FAILURE : GENERIC_FAILURE)
      }
    } catch (error) {
      dedupe.forget(chat.id, message.message_id)
      throw error
    }
  }

  async function sendCardReply(ctx: Context, text: string, buttons: Button[][]) {
    const chat = ctx.chat
    const message = ctx.msg
    if (!chat || !message) return
    const markup = inlineKeyboard(buttons)
    await asRaw(ctx.api).sendMessage({
      chat_id: chat.id,
      text,
      reply_parameters: { message_id: message.message_id },
      ...(message.message_thread_id !== undefined ? { message_thread_id: message.message_thread_id } : {}),
      ...(markup ? { reply_markup: markup } : {}),
    })
  }
}

function publicSecret(text: string, ephemeral: boolean): boolean {
  return containsLinearKey(text) && !ephemeral
}

function isGroup(chat: { type: string }): chat is { type: "group" | "supergroup"; id: number } {
  return chat.type === "group" || chat.type === "supergroup"
}

function callbackSenderChat(ctx: Context): number | undefined {
  const message = ctx.callbackQuery?.message
  if (!message || !("sender_chat" in message)) return undefined
  const sender = message.sender_chat
  return sender && typeof sender === "object" && "id" in sender && typeof sender.id === "number" ? sender.id : undefined
}

function createSeen(ttlMs = DEDUPE_TTL_MS): Seen {
  const seen = new Map<string, number>()
  const prune = (at: number) => {
    if (seen.size < 1000) return
    for (const [key, stamp] of seen) {
      if (at - stamp > ttlMs) seen.delete(key)
    }
  }
  return {
    begin(chatId, messageId) {
      const at = Date.now()
      prune(at)
      const key = `${chatId}:${messageId}`
      const stamp = seen.get(key)
      if (stamp !== undefined && at - stamp <= ttlMs) return false
      seen.set(key, at)
      return true
    },
    forget(chatId, messageId) {
      seen.delete(`${chatId}:${messageId}`)
    },
  }
}
