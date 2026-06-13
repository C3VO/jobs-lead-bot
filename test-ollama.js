require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const { buildPrompt } = require("./prompt");

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const testLead = {
    title: "[HIRING] Looking for a developer to build a Telegram bot that monitors prices on a website and alerts when price drops",
    body: "Need a bot that checks prices on a specific e-commerce site every hour and sends a Telegram notification when the price drops below a threshold. The site doesn't have an API so scraping is needed. Budget around $200-300.",
    stack: ["node", "telegram"],
    link: "https://reddit.com/r/forhire/comments/test",
    score: 8,
};

async function main() {
    console.log("Генерирую ответ через Claude API...");

    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildPrompt(testLead);

    const msg = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
    });

    const reply = (msg.content[0]?.text || "").trim();
    console.log("\nОтвет Claude:\n", reply);

    const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const text = [
        `🔥 💼 <b>${esc(testLead.title)}</b>`,
        `🔗 <a href="${testLead.link}">Открыть пост</a>`,
        `Стек: ${testLead.stack.join(", ")} | Скор: ${testLead.score}/10`,
        ``,
        `💬 <b>Готовый ответ:</b>`,
        esc(reply),
    ].join("\n");

    console.log("\nОтправляю в Telegram...");
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });

    if (!tgRes.ok) {
        const err = await tgRes.json();
        throw new Error(`Telegram: ${err.description}`);
    }
    console.log("✅ Отправлено!");
}

main().catch(console.error);
