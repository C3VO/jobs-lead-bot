"use strict";
// QR-code Telegram auth — no SMS/code needed, just scan with phone app.
// Run: node auth-tg-qr.js
// Open Telegram on phone → Settings → Devices → Link Desktop Device → scan QR

const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");
const qrcode = require("qrcode-terminal");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const apiId = parseInt(process.env.TG_API_ID || "0", 10);
    const apiHash = process.env.TG_API_HASH || "";

    if (!apiId || !apiHash) {
        console.error("Нужны TG_API_ID и TG_API_HASH в .env");
        process.exit(1);
    }

    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
        connectionRetries: 5,
        useWSS: false,
    });

    await client.connect();
    console.log("Подключено к Telegram\n");

    let sessionStr = null;

    // QR login loop — token expires every ~30s, refresh until scanned
    while (!sessionStr) {
        let result;
        try {
            result = await client.invoke(new Api.auth.ExportLoginToken({
                apiId,
                apiHash,
                exceptIds: [],
            }));
        } catch (e) {
            console.error("Ошибка получения токена:", e.message);
            await sleep(3000);
            continue;
        }

        if (result instanceof Api.auth.LoginToken) {
            const token = Buffer.from(result.token).toString("base64url");
            const url = `tg://login?token=${token}`;

            console.clear();
            console.log("═══════════════════════════════════════");
            console.log("  Открой Telegram на телефоне:        ");
            console.log("  Настройки → Устройства → Подключить ");
            console.log("  и отсканируй QR-код ниже:           ");
            console.log("═══════════════════════════════════════\n");

            qrcode.generate(url, { small: true });

            console.log("\nОжидаю сканирования... (QR обновится через 30 сек)\n");

            // Poll every 2s for ~28s, then refresh QR
            for (let i = 0; i < 14; i++) {
                await sleep(2000);

                try {
                    const poll = await client.invoke(new Api.auth.ExportLoginToken({
                        apiId,
                        apiHash,
                        exceptIds: [],
                    }));

                    if (poll instanceof Api.auth.LoginTokenMigrateTo) {
                        // Need to switch DC and import
                        await client._switchDC(poll.dcId);
                        const imported = await client.invoke(new Api.auth.ImportLoginToken({
                            token: poll.token,
                        }));
                        if (imported instanceof Api.auth.LoginTokenSuccess) {
                            sessionStr = client.session.save();
                        }
                        break;
                    }

                    if (poll instanceof Api.auth.LoginTokenSuccess) {
                        sessionStr = client.session.save();
                        break;
                    }
                } catch (e) {
                    if (e.message?.includes("SESSION_PASSWORD_NEEDED")) {
                        console.log("\nАккаунт с 2FA — нужен пароль:");
                        const readline = require("readline");
                        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                        const pwd = await new Promise((r) => rl.question("2FA пароль: ", (a) => { rl.close(); r(a); }));
                        const pwdRes = await client.invoke(new Api.account.GetPassword());
                        const { computeCheck } = require("telegram/Password");
                        const check = await computeCheck(pwdRes, pwd);
                        await client.invoke(new Api.auth.CheckPassword({ password: check }));
                        sessionStr = client.session.save();
                        break;
                    }
                    // Other errors — token might have expired, just refresh
                    break;
                }

                if (sessionStr) break;
            }

        } else if (result instanceof Api.auth.LoginTokenMigrateTo) {
            await client._switchDC(result.dcId);
            const imported = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
            if (imported instanceof Api.auth.LoginTokenSuccess) {
                sessionStr = client.session.save();
            }
        } else if (result instanceof Api.auth.LoginTokenSuccess) {
            sessionStr = client.session.save();
        }
    }

    // Check if we got the session via client.session directly
    if (!sessionStr) {
        sessionStr = client.session.save();
    }

    if (!sessionStr) {
        console.error("Не удалось получить сессию");
        process.exit(1);
    }

    console.log("\n✓ Авторизация успешна!\n");

    const envPath = path.join(__dirname, ".env");
    let envContent = fs.readFileSync(envPath, "utf8");
    if (/TG_SESSION=/.test(envContent)) {
        envContent = envContent.replace(/TG_SESSION=.*/, `TG_SESSION=${sessionStr}`);
    } else {
        envContent += `\nTG_SESSION=${sessionStr}\n`;
    }
    fs.writeFileSync(envPath, envContent, "utf8");
    console.log("✓ Сессия сохранена в .env (TG_SESSION)");
    console.log("\nТеперь запускай: pm2 start tg-groups-bot.js --name tg-scout");

    await client.disconnect();
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
