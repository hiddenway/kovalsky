export type InstrumentDefinition = {
  id: string;
  title: string;
  description: string;
  icon?: string;
};

export type InstrumentPreset = {
  agentId: string;
  customName?: string;
  goal: string;
  settings: Record<string, unknown>;
};

const TELEGRAM_BOT_TRIGGER_SCRIPT = String.raw`#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const token = (process.env.KOVALSKY_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "").trim();
const allowedChatId = (process.env.KOVALSKY_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "").trim();
const workspacePath = process.env.KOVALSKY_TRIGGER_WORKSPACE_PATH || process.cwd();
const stateDir = path.join(workspacePath, ".kovalsky", "telegram-trigger");
const stateFile = path.join(stateDir, "offset.json");

function readOffset() {
  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    const value = Number(parsed.offset);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeOffset(offset) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ offset, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    // best-effort state persistence
  }
}

if (!token) {
  console.log(JSON.stringify({
    triggered: false,
    reason: "Telegram token is missing. Set KOVALSKY_TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN.",
  }));
  process.exit(0);
}

const currentOffset = readOffset();
const requestUrl = new URL("https://api.telegram.org/bot" + token + "/getUpdates");
requestUrl.searchParams.set("timeout", "10");
requestUrl.searchParams.set("offset", String(currentOffset));
requestUrl.searchParams.set("allowed_updates", JSON.stringify(["message"]));

let response;
try {
  response = await fetch(requestUrl.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json",
    },
  });
} catch (error) {
  console.log(JSON.stringify({
    triggered: false,
    reason: "Telegram getUpdates request failed.",
    error: String(error),
  }));
  process.exit(0);
}

if (!response.ok) {
  const body = await response.text().catch(() => "");
  console.log(JSON.stringify({
    triggered: false,
    reason: "Telegram getUpdates HTTP " + response.status,
    body: body.slice(0, 500),
  }));
  process.exit(0);
}

const payload = await response.json().catch(() => null);
if (!payload || payload.ok !== true || !Array.isArray(payload.result)) {
  console.log(JSON.stringify({
    triggered: false,
    reason: "Telegram getUpdates returned invalid payload.",
  }));
  process.exit(0);
}

const updates = payload.result;
let nextOffset = currentOffset;
let selectedMessage = null;

for (const update of updates) {
  const updateId = Number(update?.update_id);
  if (Number.isFinite(updateId)) {
    nextOffset = Math.max(nextOffset, updateId + 1);
  }

  const message = update?.message;
  if (!message || typeof message !== "object") {
    continue;
  }

  const chat = message.chat;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const chatId = chat && (typeof chat.id === "number" || typeof chat.id === "string") ? String(chat.id) : "";
  const chatType = chat && typeof chat.type === "string" ? chat.type : "";

  if (!text) {
    continue;
  }
  if (chatType !== "private") {
    continue;
  }
  if (allowedChatId && chatId !== allowedChatId) {
    continue;
  }

  selectedMessage = {
    updateId: updateId || null,
    text,
    chatId,
    chatType,
    messageId: Number.isFinite(Number(message.message_id)) ? Number(message.message_id) : null,
    date: Number.isFinite(Number(message.date)) ? Number(message.date) : null,
    from: message.from ?? null,
  };
  break;
}

if (nextOffset > currentOffset) {
  writeOffset(nextOffset);
}

if (!selectedMessage) {
  console.log(JSON.stringify({
    triggered: false,
    reason: "No new private text messages for Telegram trigger.",
    diagnostics: {
      updatesChecked: updates.length,
      nextOffset,
    },
  }));
  process.exit(0);
}

console.log(JSON.stringify({
  triggered: true,
  reason: "Telegram task received from chat " + selectedMessage.chatId,
  source: "telegram_bot",
  payload: {
    chatId: selectedMessage.chatId,
    text: selectedMessage.text,
    updateId: selectedMessage.updateId,
    messageId: selectedMessage.messageId,
    chatType: selectedMessage.chatType,
    date: selectedMessage.date,
    from: selectedMessage.from,
  },
}));
`;

export const INSTRUMENT_DEFINITIONS: InstrumentDefinition[] = [
  {
    id: "telegram-bot",
    title: "Telegram Bot",
    description: "Receives private text tasks from Telegram and passes them to downstream agents via trigger input.",
    icon: "🤖",
  },
];

export function createInstrumentPreset(instrumentId: string): InstrumentPreset | null {
  if (instrumentId === "telegram-bot") {
    return {
      agentId: "trigger",
      customName: "Telegram Bot",
      goal: "Listen for Telegram private text tasks and launch downstream agents with that task payload.",
      settings: {
        command: "openclaw",
        agentId: "main",
        thinking: "minimal",
        trigger: {
          lifecycleStatus: "paused",
          summary:
            "Telegram bot poll trigger. Reads Telegram getUpdates and fires workflow on new private text message. Set KOVALSKY_TELEGRAM_BOT_TOKEN env var.",
          generated: {
            type: "script_poll",
            intervalSeconds: 3,
            timeoutSeconds: 20,
            coolDownSeconds: 5,
            scriptFileName: "telegram-trigger.mjs",
            scriptContent: TELEGRAM_BOT_TRIGGER_SCRIPT,
          },
          chat: [
            {
              role: "assistant",
              content: [
                "Telegram Bot instrument preset loaded.",
                "1) Set KOVALSKY_TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) for gateway process.",
                "2) Optional: set KOVALSKY_TELEGRAM_CHAT_ID to restrict one private chat.",
                "3) Click Activate on this Trigger node.",
              ].join("\n"),
            },
          ],
        },
      },
    };
  }

  return null;
}
