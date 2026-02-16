require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);

if (!token) {
  console.error("❌ BOT_TOKEN yo‘q! .env / Variables ni tekshiring.");
  process.exit(1);
}

/**
 * ✅ Railway network fix:
 * Railway ko'pincha PORT kutadi. Telegram bot port ochmaydi.
 * Shuning uchun kichkina HTTP server ochib qo'yamiz.
 */
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(PORT, () => console.log("✅ Health server running on PORT:", PORT));

// =====================
// ✅ DATA DIR (Railway Volume uchun)
// 1) DATA_DIR env bo'lsa -> o'sha
// 2) /data mavjud bo'lsa -> /data (Railway volume mount)
// 3) Aks holda -> __dirname (local)
// =====================
function resolveDataDir() {
  const envDir = process.env.DATA_DIR && process.env.DATA_DIR.trim();
  if (envDir) return envDir;

  try {
    if (fs.existsSync("/data")) return "/data";
  } catch (_) {}

  return __dirname;
}
const DATA_DIR = resolveDataDir();
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.log("⚠️ DATA_DIR yaratib bo'lmadi:", DATA_DIR, e.message);
}

const MOVIES_FILE = path.join(DATA_DIR, "movies.json");
const ACCESS_FILE = path.join(DATA_DIR, "access.json");

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "{}", "utf8");
}
ensureFile(MOVIES_FILE);
ensureFile(ACCESS_FILE);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ===== BOT =====
const bot = new TelegramBot(token, {
  polling: {
    interval: 300,
    params: { allowed_updates: ["message", "callback_query", "chat_join_request"] },
  },
});
bot.on("polling_error", (err) => console.log("polling_error:", err.message));

// ✅ Bot username (@ belgisisiz)
const BOT_USERNAME = "elitefilms2026_bot";

// ✅ Kanallar
const PRIVATE_CHANNELS = [
  { title: "ELITE KANAL", url: "https://t.me/+o1c3ShtbQ2U0Njli", chat_id: -1003566642594 },
  { title: "VIP KANAL", url: "https://t.me/+ZEvXaTJAjbQ5MWRi", chat_id: -1003894526572 },
  { title: "new filmms", url: "https://t.me/+GgJYp50un7UzNzg6", chat_id: -1003818931339 },
  { title: "vip filmms", url: "https://t.me/+lGp-5Har7wQ0MTcy", chat_id: -1003592186941 },
];

console.log("✅ Bot ishga tushdi.");
console.log("DATA_DIR:", DATA_DIR);

// ===== MOVIES =====
let MOVIES = readJson(MOVIES_FILE);
function saveMovies() {
  writeJson(MOVIES_FILE, MOVIES);
}

// ===== ACCESS =====
function loadAccess() {
  return readJson(ACCESS_FILE);
}
function saveAccess(data) {
  writeJson(ACCESS_FILE, data);
}
function ensureUser(access, userId) {
  const key = String(userId);
  if (!access[key]) access[key] = { ok: false, at: 0, channels: {}, last_subscribe: null };
  if (!access[key].channels) access[key].channels = {};
  return access[key];
}

function grantAccess(userId) {
  const access = loadAccess();
  const u = ensureUser(access, userId);
  u.ok = true;
  u.at = Date.now();
  saveAccess(access);
}
function revokeAccess(userId) {
  const access = loadAccess();
  const u = ensureUser(access, userId);
  u.ok = false;
  saveAccess(access);
}
function hasAccess(userId) {
  const access = loadAccess();
  return Boolean(access[String(userId)]?.ok);
}

// subscribe oynasining message_id sini saqlash
function setLastSubscribeMessage(userId, chatId, messageId) {
  const access = loadAccess();
  const u = ensureUser(access, userId);
  u.last_subscribe = { chatId, messageId, at: Date.now() };
  saveAccess(access);
}
function getLastSubscribeMessage(userId) {
  const access = loadAccess();
  return access[String(userId)]?.last_subscribe || null;
}

// ===== MEMBERSHIP CHECK =====
async function isMember(channelId, userId) {
  try {
    const m = await bot.getChatMember(channelId, userId);
    if (["member", "administrator", "creator"].includes(m.status)) return true;
    if (m.status === "restricted") return Boolean(m.is_member);
    return false;
  } catch (e) {
    console.log("getChatMember ERROR:", channelId, userId, e.message);
    return false;
  }
}

// ✅ real memberlarni "member" qilib yozib qo'yadi
async function syncMembers(userId) {
  const access = loadAccess();
  const u = ensureUser(access, userId);

  const results = await Promise.all(PRIVATE_CHANNELS.map((ch) => isMember(ch.chat_id, userId)));

  PRIVATE_CHANNELS.forEach((ch, i) => {
    const key = String(ch.chat_id);
    if (results[i]) {
      u.channels[key] = { status: "member", at: Date.now() };
    } else {
      // member bo'lmasa, member statusni o'chiramiz, requested qolishi mumkin
      if (u.channels[key]?.status === "member") delete u.channels[key];
    }
  });

  saveAccess(access);
  return results;
}

// ✅ zayavka kelsa: requested deb yozamiz (UI'da ham ✅ bo'ladi)
function markRequested(userId, channelId) {
  const access = loadAccess();
  const u = ensureUser(access, userId);
  u.channels[String(channelId)] = { status: "requested", at: Date.now() };
  saveAccess(access);
}

// ===== KEYBOARD (requested ham ✅ bo'ladi) =====
function buildSubscribeKeyboard(userId) {
  const access = loadAccess();
  const u = access[String(userId)] || {};
  const channels = u.channels || {};

  const rows = PRIVATE_CHANNELS.map((ch) => {
    const st = channels[String(ch.chat_id)]?.status; // member | requested | undefined
    const ok = st === "member" || st === "requested";
    const icon = ok ? "✅" : "❌";
    return [{ text: `${icon} ${ch.title}`, url: ch.url }];
  });

  rows.push([{ text: "✅ Tasdiqlash", callback_data: "check_sub" }]);
  return rows;
}

// ===== SUBSCRIBE SCREEN (legend yo'q) =====
async function sendSubscribeScreen(chatId, userId, messageId) {
  const text = "❌ Botdan foydalanishdan oldin quyidagi kanallarga a'zo bo‘ling.";

  const opts = {
    reply_markup: { inline_keyboard: buildSubscribeKeyboard(userId) },
    disable_web_page_preview: true,
  };

  if (messageId) {
    return bot
      .editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts })
      .catch(() =>
        bot.sendMessage(chatId, text, opts).then((m) => {
          setLastSubscribeMessage(userId, chatId, m.message_id);
          return m;
        })
      );
  }

  return bot.sendMessage(chatId, text, opts).then((m) => {
    setLastSubscribeMessage(userId, chatId, m.message_id);
    return m;
  });
}

// ===== JOIN REQUEST EVENT =====
bot.on("chat_join_request", async (req) => {
  try {
    const userId = req.from.id;
    const channelId = req.chat.id;

    const isOurChannel = PRIVATE_CHANNELS.some((ch) => ch.chat_id === channelId);
    if (!isOurChannel) return;

    markRequested(userId, channelId);

    const last = getLastSubscribeMessage(userId);
    if (last?.chatId && last?.messageId) {
      await sendSubscribeScreen(last.chatId, userId, last.messageId).catch(() => {});
    }
  } catch (e) {
    console.log("chat_join_request error:", e.message);
  }
});

// ===== CALLBACK: ✅ Tasdiqlash =====
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const userId = q.from?.id;
  if (!chatId || !userId) return;

  if (q.data === "check_sub") {
    await syncMembers(userId);

    const access = loadAccess();
    const u = access[String(userId)] || {};
    const chmap = u.channels || {};

    const complete = PRIVATE_CHANNELS.every((ch) => {
      const st = chmap[String(ch.chat_id)]?.status;
      return st === "member" || st === "requested";
    });

    if (complete) {
      grantAccess(userId);
      await bot.answerCallbackQuery(q.id);

      const okText = "🎬 Endi kino kodini yuboring";
      return bot
        .editMessageText(okText, { chat_id: chatId, message_id: q.message.message_id })
        .catch(() => bot.sendMessage(chatId, okText));
    }

    revokeAccess(userId);
    await bot.answerCallbackQuery(q.id, { text: "❌ Hali hammasi emas!", show_alert: true });
    return sendSubscribeScreen(chatId, userId, q.message.message_id);
  }
});

// ===== ADMIN =====
bot.onText(/\/myid/, (msg) => {
  bot.sendMessage(msg.chat.id, `Sizning ID: ${msg.from.id}`);
});

const waitingVideoForCode = new Map();

bot.onText(/\/add\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "❌ Siz admin emassiz.");

  const code = match[1];
  waitingVideoForCode.set(msg.chat.id, code);
  bot.sendMessage(msg.chat.id, `✅ Kod qabul qilindi: ${code}\nEndi video yoki fayl yuboring`);
});

bot.onText(/\/del\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "❌ Siz admin emassiz.");

  const code = match[1];
  if (!MOVIES[code]) return bot.sendMessage(msg.chat.id, "❌ Bunday kod yo‘q.");

  delete MOVIES[code];
  saveMovies();
  bot.sendMessage(msg.chat.id, `🗑️ O‘chirildi: ${code}`);
});

bot.onText(/\/list/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  const keys = Object.keys(MOVIES);
  if (keys.length === 0) return bot.sendMessage(msg.chat.id, "Hozircha kino yo‘q.");

  bot.sendMessage(msg.chat.id, "🎬 Kinolar:\n" + keys.map((k) => `• ${k}`).join("\n"));
});

bot.on("video", (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  const code = waitingVideoForCode.get(msg.chat.id);
  if (!code) return;

  MOVIES[code] = msg.video.file_id;
  saveMovies();

  waitingVideoForCode.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, `✅ Saqlandi!\nKod: ${code}`);
});

bot.on("document", (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  const code = waitingVideoForCode.get(msg.chat.id);
  if (!code) return;

  MOVIES[code] = msg.document.file_id;
  saveMovies();

  waitingVideoForCode.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, `✅ Saqlandi!\nKod: ${code}`);
});

// ===== USER =====
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  await syncMembers(userId).catch(() => {});
  if (!hasAccess(userId)) return sendSubscribeScreen(chatId, userId);

  bot.sendMessage(chatId, "🎬 Kino kodini yuboring");
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!hasAccess(userId)) return sendSubscribeScreen(chatId, userId);

  const code = msg.text.trim();
  const fileId = MOVIES[code];

  if (!fileId) return bot.sendMessage(chatId, "❌ Bunday kod topilmadi.");

  const caption = `🎬 Kino kodi: ${code}\n🤖 Bizning bot: @${BOT_USERNAME}\n`;

  return bot
    .sendVideo(chatId, fileId, { caption })
    .catch(() => bot.sendDocument(chatId, fileId, { caption }));
});
