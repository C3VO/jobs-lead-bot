"use strict";
// One-time interactive auth for Telegram userbot.
// Run: node auth-tg.js
// Enter phone + code from Telegram app → session string saved to .env

const fs = require("fs");
const path = require("path");
const readline = require("readline");
require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

async function main() {
    const apiId = parseInt(process.env.TG_API_ID || "0", 10);
    const apiHash = process.env.TG_API_HASH || "";

    if (!apiId || !apiHash) {
        console.error("Нужны TG_API_ID и TG_API_HASH в .env (из my.telegram.org)");
        process.exit(1);
    }

    console.log("─── Авторизация Telegram аккаунта ───");
    console.log("Код придёт в Telegram — посмотри в приложении (даже в другой сессии)\n");

    const session = new StringSession("");
    const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        useWSS: false,
        baseLogger: { warn: () => {}, error: console.error, info: () => {}, debug: () => {} },
    });

    console.log("Подключаюсь к Telegram...");
    await client.connect();
    console.log("Подключено. Отправляю код...\n");

    await client.start({
        phoneNumber: async () => {
            const phone = await ask("Номер телефона (+380...): ");
            console.log(`\nОтправляю код на ${phone}...`);
            return phone;
        },
        phoneCode: async () => {
            console.log("Код отправлен! Проверь:");
            console.log("  • Сообщение от 'Telegram' в приложении на телефоне/компьютере");
            console.log("  • Или SMS если нет активных сессий\n");
            return ask("Введи код: ");
        },
        password: () => ask("2FA пароль (Enter если нет): "),
        onError: (err) => { console.error("Ошибка:", err.message); },
    });

    const sessionStr = client.session.save();

    console.log("\n✓ Авторизация успешна!\n");
    console.log("Session string (скопируй на всякий случай):");
    console.log(sessionStr);
    console.log();

    // Save to .env
    const envPath = path.join(__dirname, ".env");
    let envContent = fs.readFileSync(envPath, "utf8");
    if (/TG_SESSION=/.test(envContent)) {
        envContent = envContent.replace(/TG_SESSION=.*/, `TG_SESSION=${sessionStr}`);
    } else {
        envContent += `\nTG_SESSION=${sessionStr}\n`;
    }
    fs.writeFileSync(envPath, envContent, "utf8");
    console.log("✓ Сессия сохранена в .env (TG_SESSION)");

    await client.disconnect();
    rl.close();
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
