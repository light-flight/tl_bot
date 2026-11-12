import type { Button } from "./setup.js"

export type TelegramRaw = {
  sendMessage: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  editMessageText: (args: Record<string, unknown>) => Promise<unknown>
  editEphemeralMessageText: (args: Record<string, unknown>) => Promise<unknown>
  deleteEphemeralMessage: (args: Record<string, unknown>) => Promise<unknown>
  deleteMessage: (args: Record<string, unknown>) => Promise<unknown>
  setMyCommands: (args: Record<string, unknown>) => Promise<unknown>
}

export function asRaw(api: { raw: object }): TelegramRaw {
  return api.raw as TelegramRaw
}

export function inlineKeyboard(buttons: Button[][]): Record<string, unknown> | undefined {
  if (buttons.length === 0) return undefined
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: button.data,
        ...(button.style ? { style: button.style } : {}),
      })),
    ),
  }
}

export function ephemeralId(message: object | undefined): number | undefined {
  if (!message || !("ephemeral_message_id" in message)) return undefined
  const value = message.ephemeral_message_id
  return typeof value === "number" ? value : undefined
}

export function receiverId(message: object | undefined): number | undefined {
  if (!message || !("receiver_user" in message)) return undefined
  const receiver = message.receiver_user
  if (!receiver || typeof receiver !== "object" || !("id" in receiver)) return undefined
  return typeof receiver.id === "number" ? receiver.id : undefined
}

export async function sendEphemeral(
  raw: TelegramRaw,
  input: {
    chatId: number
    userId: number
    text: string
    buttons?: Button[][]
    threadId?: number
    replyToEphemeralId?: number
    callbackQueryId?: string
    replaceCallbackMessage?: boolean
  },
): Promise<number | undefined> {
  const markup = input.buttons ? inlineKeyboard(input.buttons) : undefined
  const sent = await raw.sendMessage({
    chat_id: input.chatId,
    text: input.text,
    ...(input.threadId !== undefined ? { message_thread_id: input.threadId } : {}),
    ...(markup ? { reply_markup: markup } : {}),
    ephemeral_message_parameters: {
      receiver_user_id: input.userId,
      ...(input.callbackQueryId ? { callback_query_id: input.callbackQueryId } : {}),
      ...(input.replaceCallbackMessage ? { replace_callback_query_message: true } : {}),
    },
    ...(input.replyToEphemeralId !== undefined ? { reply_parameters: { ephemeral_message_id: input.replyToEphemeralId } } : {}),
  })
  return ephemeralId(sent)
}

export async function editEphemeral(
  raw: TelegramRaw,
  input: { chatId: number; userId: number; ephemeralMessageId: number; text: string; buttons?: Button[][] },
): Promise<void> {
  const markup = input.buttons ? inlineKeyboard(input.buttons) : { inline_keyboard: [] }
  await raw.editEphemeralMessageText({
    chat_id: input.chatId,
    receiver_user_id: input.userId,
    ephemeral_message_id: input.ephemeralMessageId,
    text: input.text,
    reply_markup: markup,
  })
}

export async function deleteEphemeral(raw: TelegramRaw, chatId: number, userId: number, ephemeralMessageId: number): Promise<void> {
  try {
    await raw.deleteEphemeralMessage({
      chat_id: chatId,
      receiver_user_id: userId,
      ephemeral_message_id: ephemeralMessageId,
    })
  } catch {
    // The command is already hidden from the group. Deletion is best-effort.
  }
}

export async function deletePlain(raw: TelegramRaw, chatId: number, messageId: number): Promise<void> {
  try {
    await raw.deleteMessage({ chat_id: chatId, message_id: messageId })
  } catch {
    // The bot can delete a group message only when it is allowed to.
  }
}

export async function registerCommands(raw: TelegramRaw): Promise<void> {
  await raw.setMyCommands({
    commands: [
      { command: "setup", description: "Настроить Linear для этого чата", is_ephemeral: true },
      { command: "key", description: "Ключ Linear. Сообщение видите только вы", is_ephemeral: true },
      { command: "assignees", description: "Соответствия исполнителей. Видите только вы", is_ephemeral: true },
      { command: "settings", description: "Текущие настройки чата", is_ephemeral: true },
      { command: "cancel", description: "Отменить незавершённую настройку", is_ephemeral: true },
    ],
    scope: { type: "all_group_chats" },
  })
  await raw.setMyCommands({
    commands: [{ command: "start", description: "Справка" }],
    scope: { type: "all_private_chats" },
  })
  await raw.setMyCommands({
    commands: [{ command: "start", description: "Справка" }],
    scope: { type: "default" },
  })
}
