"use strict";
// Telegram group scout bot
// - Searches groups by keywords, joins promising ones
// - Monitors messages with AI classification
// - After TTL_DAYS with no leads → leaves + blacklists group

const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { Api } = require("telegram");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// ─── Config ──────────────────────────────────────────────────────────────────

const ENV = process.env;
const DATA_DIR = path.join(__dirname, "data");
const GROUPS_FILE = path.join(DATA_DIR, "tg-groups.json");
const BLACKLIST_FILE = path.join(DATA_DIR, "tg-blacklist.json");
const LEADS_FILE = path.join(DATA_DIR, "leads.jsonl");

const API_ID = parseInt(ENV.TG_API_ID || "0", 10);
const API_HASH = ENV.TG_API_HASH || "";
const SESSION_STR = ENV.TG_SESSION || "";

const TG_BOT_TOKEN = ENV.TG_BOT_TOKEN || "";
const TG_CHAT_ID = ENV.TG_CHAT_ID || "";

const AI_API_KEY = ENV.AI_API_KEY || "";
const AI_BASE_URL = (ENV.AI_BASE_URL || "https://api.openmodel.ai").replace(/\/$/, "");
const AI_MODEL = ENV.AI_MODEL || "claude-haiku-4-5-20251001";

const TTL_DAYS = parseInt(ENV.TG_GROUP_TTL_DAYS || "7", 10);
const JOIN_LIMIT = parseInt(ENV.TG_GROUP_JOIN_LIMIT || "30", 10);
const MIN_MEMBERS = parseInt(ENV.TG_GROUP_MIN_MEMBERS || "50", 10);
const SEARCH_INTERVAL_MS = parseInt(ENV.TG_GROUP_SEARCH_HOURS || "6", 10) * 3600_000;
const CLEANUP_INTERVAL_MS = 3600_000; // check every hour

// Keywords to search for groups (finds groups by name/description)
const SEARCH_KEYWORDS = (ENV.TG_GROUP_SEARCH_KEYWORDS || "").split(",").map(s => s.trim()).filter(Boolean);
const DEFAULT_KEYWORDS = [
    "ищу разработчика", "нужен разработчик", "разработчик нужен",
    "ищу фрилансера", "нужен фрилансер",
    "заказать сайт", "сделать сайт", "создать сайт",
    "wordpress помощь", "wordpress фриланс", "opencart",
    "web developer", "frontend разработчик", "fullstack developer",
    "shopify разработчик", "woocommerce",
    "розробник потрібен", "шукаю розробника", "замовити сайт",
    "freelance developer", "hire developer",
];
const KEYWORDS = SEARCH_KEYWORDS.length ? SEARCH_KEYWORDS : DEFAULT_KEYWORDS;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const log = (...a) => console.log(new Date().toISOString(), "-", ...a);
const logErr = (...a) => console.error(new Date().toISOString(), "-", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── State ────────────────────────────────────────────────────────────────────
// groups: { [chatId]: { id, name, username, joinedAt, lastLeadAt, leadsCount, msgCount } }
// blacklist: Set of chat IDs and usernames

let groups = {};
let blacklist = new Set();
let lastSearchAt = 0;

function loadState() {
    try { groups = JSON.parse(fs.readFileSync(GROUPS_FILE, "utf8")); } catch { groups = {}; }
    try { blacklist = new Set(JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"))); } catch { blacklist = new Set(); }
    log(`State loaded: ${Object.keys(groups).length} groups, ${blacklist.size} blacklisted`);
}

function saveState() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([...blacklist], null, 2));
}

function appendLead(lead) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LEADS_FILE, JSON.stringify(lead) + "\n");
}

// ─── AI ───────────────────────────────────────────────────────────────────────

async function classifyMessage(text) {
    if (!AI_API_KEY) return false;
    const res = await fetch(`${AI_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": AI_API_KEY,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: AI_MODEL,
            max_tokens: 5,
            messages: [{
                role: "user",
                content:
                    `Is someone in this Telegram message looking to HIRE a web developer, programmer, or get paid technical help with a website, app, or online store? Reply YES or NO only.\n\n"${text.slice(0, 700)}"`,
            }],
        }),
    });
    if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
    const data = await res.json();
    return (data.content?.[0]?.text || "").toUpperCase().startsWith("YES");
}

// ─── Telegram Bot send ────────────────────────────────────────────────────────

async function sendToChat(html) {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!res.ok) logErr("sendToChat error:", await res.text());
}

// ─── Group search & join ──────────────────────────────────────────────────────

async function searchAndJoin(client) {
    log(`Searching groups with ${KEYWORDS.length} keywords...`);
    const candidates = new Map(); // id → chat object

    for (const kw of KEYWORDS) {
        try {
            await sleep(1500);
            const result = await client.invoke(new Api.contacts.Search({ q: kw, limit: 20 }));
            for (const chat of (result.chats || [])) {
                // Only megagroups (supergroups) — regular channels are write-only
                if (!chat.megagroup) continue;
                const id = String(chat.id);
                if (!candidates.has(id)) candidates.set(id, chat);
            }
        } catch (e) {
            logErr(`Search "${kw}": ${e.message}`);
        }
    }

    log(`Found ${candidates.size} unique groups`);
    let joined = 0;

    for (const [id, chat] of candidates) {
        if (Object.keys(groups).length >= JOIN_LIMIT) {
            log(`Join limit (${JOIN_LIMIT}) reached`);
            break;
        }

        const username = chat.username || "";
        if (groups[id]) continue;
        if (blacklist.has(id) || blacklist.has(username)) continue;
        if ((chat.participantsCount || 0) < MIN_MEMBERS) continue;

        await sleep(3000);
        try {
            await client.invoke(new Api.channels.JoinChannel({ channel: chat }));
            groups[id] = {
                id,
                name: chat.title || "Unknown",
                username,
                joinedAt: Date.now(),
                lastLeadAt: null,
                leadsCount: 0,
                msgCount: 0,
            };
            log(`✓ Joined: ${chat.title} (@${username || id}) — ${chat.participantsCount} members`);
            joined++;
        } catch (e) {
            logErr(`Join "${chat.title}": ${e.message}`);
            // INVITE_HASH_EXPIRED, CHANNELS_TOO_MUCH etc — skip
        }
    }

    saveState();
    log(`Joined ${joined} new groups. Total active: ${Object.keys(groups).length}`);
    lastSearchAt = Date.now();
}

// ─── Group cleanup ────────────────────────────────────────────────────────────

async function cleanupGroups(client) {
    const now = Date.now();
    const TTL = TTL_DAYS * 86_400_000;
    let left = 0;

    for (const [id, g] of Object.entries(groups)) {
        const age = now - g.joinedAt;
        if (age < TTL) continue;

        // If had a recent lead (within TTL) — keep the group
        if (g.lastLeadAt && now - g.lastLeadAt < TTL) continue;

        const days = Math.round(age / 86_400_000);
        log(`Leaving ${g.name} — ${days}d old, ${g.leadsCount} leads total`);

        try {
            const peer = g.username || id;
            const entity = await client.getInputEntity(peer);
            await client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
        } catch (e) {
            logErr(`Leave ${g.name}: ${e.message}`);
        }

        blacklist.add(id);
        if (g.username) blacklist.add(g.username);
        delete groups[id];
        left++;
        await sleep(2000);
    }

    if (left) {
        saveState();
        log(`Cleanup: left ${left} groups, ${Object.keys(groups).length} remain`);
    }
}

// ─── Message handler ──────────────────────────────────────────────────────────

function setupHandler(client) {
    client.addEventHandler(async (event) => {
        try {
            const msg = event.message;
            if (!msg?.text || msg.text.length < 15) return;

            const chatId = String(event.chatId || "");
            const group = groups[chatId];
            if (!group) return;

            group.msgCount++;

            let isLead = false;
            try {
                isLead = await classifyMessage(msg.text);
            } catch (e) {
                logErr(`AI classify in ${group.name}: ${e.message}`);
                return;
            }

            log(`AI [${group.name.slice(0, 30)}] "${msg.text.slice(0, 60)}" → ${isLead ? "YES 🔥" : "no"}`);

            if (!isLead) return;

            group.leadsCount++;
            group.lastLeadAt = Date.now();
            saveState();

            const link = group.username
                ? `https://t.me/${group.username}/${msg.id}`
                : `tg://openmessage?chat_id=${chatId.replace("-100", "")}&message_id=${msg.id}`;

            const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

            await sendToChat([
                `🔍 <b>Лид из TG группы</b>`,
                `📌 <b>${esc(group.name)}</b>`,
                `🔗 <a href="${link}">Открыть сообщение</a>`,
                ``,
                esc(msg.text.slice(0, 800)),
            ].join("\n"));

            appendLead({
                id: `tggrp_${chatId}_${msg.id}`,
                source: "telegram_group",
                subreddit: group.name,
                title: msg.text.slice(0, 120),
                body: msg.text,
                link,
                created_utc: Math.floor(Date.now() / 1000),
                score: 7,
                type: "freelance",
                postRole: "hiring",
                stack: [],
                budget: null,
                hasScope: false,
                equity: false,
                deadline: false,
            });

        } catch (e) {
            logErr("Message handler error:", e.message);
        }
    }, new NewMessage({ incoming: true }));

    log("Message handler registered");
}

// ─── Status report ────────────────────────────────────────────────────────────

function logStatus() {
    const now = Date.now();
    const active = Object.values(groups);
    const withLeads = active.filter(g => g.leadsCount > 0).length;
    const expiringSoon = active.filter(g => {
        const age = now - g.joinedAt;
        return age > (TTL_DAYS - 1) * 86_400_000;
    }).length;
    log(`Status: ${active.length} groups (${withLeads} with leads, ${expiringSoon} expiring in <1d), blacklist: ${blacklist.size}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    if (!API_ID || !API_HASH) {
        console.error("Нужны TG_API_ID и TG_API_HASH в .env");
        process.exit(1);
    }
    if (!SESSION_STR) {
        console.error("Нужен TG_SESSION. Запусти node auth-tg.js для авторизации.");
        process.exit(1);
    }

    log("Starting TG group scout...");
    fs.mkdirSync(DATA_DIR, { recursive: true });
    loadState();

    const client = new TelegramClient(
        new StringSession(SESSION_STR),
        API_ID,
        API_HASH,
        { connectionRetries: 10, useWSS: false }
    );

    await client.connect();
    log("TG connected");

    setupHandler(client);

    // First run: search immediately
    await searchAndJoin(client).catch((e) => logErr("Initial search:", e.message));
    logStatus();

    // Periodic group search
    setInterval(async () => {
        if (Date.now() - lastSearchAt < SEARCH_INTERVAL_MS) return;
        await searchAndJoin(client).catch((e) => logErr("Periodic search:", e.message));
        logStatus();
    }, 30 * 60 * 1000); // check every 30 min if it's time to search

    // Periodic cleanup
    setInterval(async () => {
        await cleanupGroups(client).catch((e) => logErr("Cleanup:", e.message));
    }, CLEANUP_INTERVAL_MS);

    // Status log every 6 hours
    setInterval(logStatus, 6 * 3600_000);

    log("Bot running. Ctrl+C to stop.");

    // Keep alive
    process.on("SIGINT", async () => {
        log("Shutting down...");
        await client.disconnect();
        process.exit(0);
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
