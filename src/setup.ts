import { randomBytes } from "node:crypto"
import { findMappedUser, type LinearUser } from "./assignees.js"
import { parseAssigneeMap, type AssigneeMap } from "./config.js"
import { containsLinearKey } from "./secrets.js"
import {
  DRAFT_TTL_MS,
  entriesFromMap,
  type ChatSettings,
  type DraftIntent,
  type SetupDraft,
} from "./settings.js"

export type Button = {
  text: string
  data: string
  style?: "primary" | "danger" | "success"
}

export type Card = {
  text: string
  buttons: Button[][]
}

export type WizardAction =
  | { type: "team"; id: string }
  | { type: "teams"; page: number }
  | { type: "project"; id: string }
  | { type: "projects"; page: number }
  | { type: "no-project" }
  | { type: "no-map" }
  | { type: "done" }
  | { type: "reset" }
  | { type: "reset-yes" }
  | { type: "edit-team" }
  | { type: "edit-project" }

export type KeyDecision =
  | { type: "not-hidden" }
  | { type: "empty" }
  | { type: "bad-format" }
  | { type: "ready"; key: string }

const PAGE_SIZE = 8
const BUTTON_TEXT = 40
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

export const ADMIN_ONLY = "Только администратор чата может настроить бота."
export const CHECKING_KEY = "Проверяю ключ…"
export const KEY_REJECTED = "Linear не принял ключ. Пришлите другой командой /key."
export const KEY_UNREACHABLE = "Не получилось связаться с Linear. Пришлите /key ещё раз."
export const KEY_FORMAT = "Ключ Linear начинается с lin_api_. Пришлите его командой /key."
export const KEY_RATE_LIMIT = "Слишком много попыток. Подождите и пришлите /key ещё раз."
export const NOT_HIDDEN =
  "Команда пришла как обычное сообщение, его видят все. Обновите Telegram и отправьте её снова. Ключ в общий чат не присылайте."
export const LEAK_WARNING =
  "Сообщение с ключом видят все участники. Удалите его и пришлите ключ командой /key: её видит только отправитель."
export const PRIVATE_HINT = "Откройте группу и нажмите «Настроить». Ключ привязан к чату, в личку его присылать не нужно."
export const DISCONNECTED = "Linear отключён."
export const AUTH_FAILURE =
  "Не смог создать задачу. Возможно, ключ Linear больше не действует: администратор может обновить его командой /key."
export const GENERIC_FAILURE = "Не смог создать задачу в Linear. Попробуйте ещё раз."
export const NO_TEAMS = "В этом ключе нет команд Linear."
export const LOAD_FAILED = "Не получилось загрузить данные Linear. Попробуйте ещё раз."
export const ASSIGNEE_HELP =
  "Пришлите соответствия командой /assignees или нажмите «Без карты». Формат: telegram_username:linear_email или telegram_id:linear_user_id, через запятую."

export function setupCard(): Card {
  return {
    text: [
      "Я создаю задачи в Linear, когда меня отмечают.",
      "",
      "Настройка занимает минуту и видна только вам: ключ, команда, проект, исполнители.",
    ].join("\n"),
    buttons: [[{ text: "Настроить", data: "onboard", style: "primary" }]],
  }
}

export function connectedCard(settings: ChatSettings, withEditButton: boolean): Card {
  const project = settings.projectName ? `, проект ${settings.projectName}` : ""
  return {
    text: `Linear подключён: команда ${settings.teamKey}${project}.`,
    buttons: withEditButton ? [[{ text: "Изменить", data: "edit", style: "primary" }]] : [],
  }
}

export function onboardingCard(settings: ChatSettings | null): Card {
  if (!settings) return setupCard()
  return connectedCard(settings, true)
}

export function keyStepText(): string {
  return [
    "Шаг 1 из 4. Ключ Linear.",
    "Linear → Settings → Security & access → API → Personal API keys.",
    "Пришлите ключ командой /key lin_api_…",
    "Её видите только вы.",
  ].join("\n")
}

export function teamPrompt(intent: DraftIntent): string {
  if (intent === "setup") return "Шаг 2 из 4. Выберите команду."
  return "Выберите команду."
}

export function projectPrompt(intent: DraftIntent, teamKey: string): string {
  const prefix = intent === "setup" ? "Шаг 3 из 4. " : ""
  return `${prefix}Команда ${teamKey}. Выберите проект.`
}

export function assigneePrompt(teamKey: string, projectName: string | null, lines: string[]): string {
  const project = projectName ? `проект ${projectName}` : "без проекта"
  const saved = lines.length > 0 ? `\n\n${lines.join("\n")}` : ""
  return `Шаг 4 из 4. Команда ${teamKey}, ${project}.${saved}\n\n${ASSIGNEE_HELP}`
}

export function settingsText(settings: ChatSettings): string {
  const project = settings.projectName ?? "без проекта"
  return [
    `Команда ${settings.teamKey}`,
    `Проект ${project}`,
    `Исполнителей: ${settings.assigneeMap.size}`,
    "Ключ сохранён.",
    "Сменить ключ: /key",
    "Сменить соответствия: /assignees",
  ].join("\n")
}

export function settingsButtons(nonce: string): Button[][] {
  return [
    [{ text: "Сменить команду", data: callback(nonce, "editteam") }],
    [{ text: "Сменить проект", data: callback(nonce, "editproj") }],
    [{ text: "Сбросить", data: callback(nonce, "reset"), style: "danger" }],
  ]
}

export function confirmResetText(): string {
  return "Удалить настройки Linear для этого чата?"
}

export function confirmResetButtons(nonce: string): Button[][] {
  return [[{ text: "Удалить", data: callback(nonce, "resetok"), style: "danger" }]]
}

export function teamButtons(
  nonce: string,
  teams: { id: string; key: string; name: string }[],
  page: number,
): Button[][] {
  return pagedButtons(nonce, teams, page, "teams", (team) => ({
    text: clip(`${team.key} · ${team.name}`),
    data: callback(nonce, `team.${team.id}`),
  }))
}

export function projectButtons(nonce: string, projects: { id: string; name: string }[], page: number): Button[][] {
  const rows = pagedButtons(nonce, projects, page, "projs", (project) => ({
    text: clip(project.name),
    data: callback(nonce, `proj.${project.id}`),
  }))
  rows.push([{ text: "Без проекта", data: callback(nonce, "noproj") }])
  return rows
}

export function assigneeButtons(nonce: string): Button[][] {
  return [
    [
      { text: "Без карты", data: callback(nonce, "nomap") },
      { text: "Готово", data: callback(nonce, "done"), style: "success" },
    ],
  ]
}

export function startSetup(input: { isAdmin: boolean; now: number }): { ok: false } | { ok: true; draft: SetupDraft } {
  if (!input.isAdmin) return { ok: false }
  return { ok: true, draft: createDraft(input.now, "setup", "key") }
}

export function createDraft(now: number, intent: DraftIntent, step: SetupDraft["step"]): SetupDraft {
  return {
    nonce: randomBytes(4).toString("hex"),
    expiresAt: now + DRAFT_TTL_MS,
    step,
    intent,
    assigneeMap: [],
  }
}

export function draftFromSettings(settings: ChatSettings, now: number, intent: DraftIntent, step: SetupDraft["step"]): SetupDraft {
  return {
    ...createDraft(now, intent, step),
    apiKey: settings.linearApiKey,
    teamId: settings.teamId,
    teamKey: settings.teamKey,
    projectId: settings.projectId,
    projectName: settings.projectName,
    assigneeMap: entriesFromMap(settings.assigneeMap),
  }
}

export function touch(draft: SetupDraft, now: number): SetupDraft {
  return { ...draft, expiresAt: now + DRAFT_TTL_MS }
}

export function withKey(draft: SetupDraft, apiKey: string, now: number): SetupDraft {
  return touch({ ...draft, apiKey, step: "team" }, now)
}

export function withTeam(draft: SetupDraft, team: { id: string; key: string }, now: number): SetupDraft {
  return touch(
    {
      ...draft,
      teamId: team.id,
      teamKey: team.key,
      projectId: null,
      projectName: null,
      step: "project",
    },
    now,
  )
}

export function withProject(
  draft: SetupDraft,
  project: { id: string; name: string } | null,
  now: number,
): SetupDraft {
  return touch(
    {
      ...draft,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      step: draft.intent === "setup" ? "assignees" : draft.step,
    },
    now,
  )
}

export function withAssignees(draft: SetupDraft, map: AssigneeMap, now: number): SetupDraft {
  return touch({ ...draft, assigneeMap: entriesFromMap(map), step: "assignees" }, now)
}

export function toSettings(draft: SetupDraft): ChatSettings | null {
  if (!draft.apiKey || !draft.teamId || !draft.teamKey) return null
  return {
    linearApiKey: draft.apiKey,
    teamId: draft.teamId,
    teamKey: draft.teamKey,
    projectId: draft.projectId ?? null,
    projectName: draft.projectName ?? null,
    assigneeMap: new Map(draft.assigneeMap),
  }
}

export function keyDecision(input: { ephemeral: boolean; argument: string }): KeyDecision {
  if (!input.ephemeral) return { type: "not-hidden" }
  const key = input.argument.trim()
  if (!key) return { type: "empty" }
  if (!key.startsWith("lin_api_") || key.length > 200 || /\s/.test(key)) return { type: "bad-format" }
  return { type: "ready", key }
}

export function hiddenCommand(ephemeral: boolean): boolean {
  return ephemeral
}

export function parseWizardData(data: string): { nonce: string; action: WizardAction } | null {
  const match = /^v1\.([0-9a-f]{8})\.(team|teams|proj|projs|noproj|nomap|done|reset|resetok|editteam|editproj)(?:\.(.+))?$/.exec(
    data,
  )
  if (!match) return null
  const nonce = match[1]
  const kind = match[2]
  const rest = match[3]
  if (!nonce || !kind) return null

  if (kind === "team" && rest && ID_PATTERN.test(rest)) return { nonce, action: { type: "team", id: rest } }
  if (kind === "proj" && rest && ID_PATTERN.test(rest)) return { nonce, action: { type: "project", id: rest } }
  if (kind === "teams" && rest && /^\d+$/.test(rest)) return { nonce, action: { type: "teams", page: Number(rest) } }
  if (kind === "projs" && rest && /^\d+$/.test(rest)) return { nonce, action: { type: "projects", page: Number(rest) } }
  if (rest) return null
  if (kind === "noproj") return { nonce, action: { type: "no-project" } }
  if (kind === "nomap") return { nonce, action: { type: "no-map" } }
  if (kind === "done") return { nonce, action: { type: "done" } }
  if (kind === "reset") return { nonce, action: { type: "reset" } }
  if (kind === "resetok") return { nonce, action: { type: "reset-yes" } }
  if (kind === "editteam") return { nonce, action: { type: "edit-team" } }
  if (kind === "editproj") return { nonce, action: { type: "edit-project" } }
  return null
}

export function acceptWizardCallback(draft: SetupDraft | null, nonce: string, now: number): draft is SetupDraft {
  return draft !== null && draft.nonce === nonce && draft.expiresAt > now
}

export type AssigneeCheck =
  | { ok: true; map: AssigneeMap; lines: string[] }
  | { ok: false; message: string }

export function validateAssignees(raw: string, users: LinearUser[]): AssigneeCheck {
  let map: AssigneeMap
  try {
    map = parseAssigneeMap(raw)
  } catch {
    return { ok: false, message: "Каждая запись должна быть в виде ключ:значение, через запятую." }
  }
  if (map.size === 0) return { ok: false, message: ASSIGNEE_HELP }

  const missing: string[] = []
  const lines: string[] = []
  for (const [key, value] of map) {
    const user = findMappedUser(users, value)
    if (!user) {
      missing.push(key)
      continue
    }
    lines.push(`${key} → ${user.name}`)
  }
  if (missing.length > 0) {
    return { ok: false, message: `В Linear нет: ${missing.join(", ")}. Карта не изменена.` }
  }
  return { ok: true, map, lines }
}

export function assigneeLines(map: AssigneeMap, users: LinearUser[]): string[] {
  return [...map].map(([key, value]) => {
    const user = findMappedUser(users, value)
    return `${key} → ${user?.name ?? value}`
  })
}

export function publicSecret(text: string, ephemeral: boolean): boolean {
  return containsLinearKey(text) && !ephemeral
}

function callback(nonce: string, action: string): string {
  return `v1.${nonce}.${action}`
}

function clip(text: string): string {
  return text.length <= BUTTON_TEXT ? text : `${text.slice(0, BUTTON_TEXT - 1)}…`
}

function pagedButtons<T>(
  nonce: string,
  items: T[],
  page: number,
  pageAction: "teams" | "projs",
  render: (item: T) => Button,
): Button[][] {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const safe = Math.min(Math.max(page, 0), pages - 1)
  const slice = items.slice(safe * PAGE_SIZE, (safe + 1) * PAGE_SIZE)
  const rows = slice.map((item) => [render(item)])
  if (pages > 1) {
    const nav: Button[] = []
    if (safe > 0) nav.push({ text: "←", data: callback(nonce, `${pageAction}.${safe - 1}`) })
    if (safe < pages - 1) nav.push({ text: "→", data: callback(nonce, `${pageAction}.${safe + 1}`) })
    rows.push(nav)
  }
  return rows
}
