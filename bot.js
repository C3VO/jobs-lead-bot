const fs = require("fs");
require("dotenv").config();
const path = require("path");
const { buildPrompt } = require("./prompt");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// Paths
const DATA_DIR = path.join(__dirname, "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.jsonl");
const SEEN_FILE = path.join(__dirname, "seen.json");
const STATE_FILE = path.join(__dirname, "state.json");

const argv = new Set(process.argv.slice(2));
const ENV = process.env;

const log = (...args) => console.log(new Date().toISOString(), "-", ...args);
const logError = (...args) => console.error(new Date().toISOString(), "-", ...args);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseList = (name, fallback) => {
    const raw = ENV[name];
    if (!raw) return fallback;
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
};

const parsePositiveInt = (name, fallback) => {
    const n = parseInt(ENV[name], 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const parseBool = (name, fallback) => {
    const raw = ENV[name];
    if (raw === undefined) return fallback;
    return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
};

const intervalMinutes = parsePositiveInt("INTERVAL_MINUTES", 10); // default 10 минут
const translateEnabled = parseBool("TRANSLATE_ENABLED", true); // включено по умолчанию по запросу
const buildLibreConfig = () => {
    if (!translateEnabled) return null;
    const url = ENV.LIBRETRANSLATE_URL || "https://libretranslate.com/translate";
    const apiKey = ENV.LIBRETRANSLATE_API_KEY || null;
    const from = ENV.LIBRETRANSLATE_FROM || "en";
    const to = ENV.LIBRETRANSLATE_TO || "ru";

    // Публичный libretranslate.com требует api_key; если его нет — отключаем перевод, чтобы не спамить 400.
    if (url.includes("libretranslate.com") && !apiKey) {
        log("Перевод отключён: публичный libretranslate.com требует LIBRETRANSLATE_API_KEY. Укажи ключ или разверни локальный LibreTranslate.");
        return null;
    }

    return { url, from, to, apiKey };
};
const libreConfig = buildLibreConfig();
const requestDelayMs = parsePositiveInt("REQUEST_DELAY_MS", 0);
const maxRequestsPerRun = parsePositiveInt("MAX_REQUESTS_PER_RUN", 500);
const USER_AGENT =
    ENV.REDDIT_USER_AGENT || `script:reddit-jobs-telegram-bot:1.0 (by /u/${ENV.REDDIT_USERNAME || "unknown"})`;

const redditAuth = {
    clientId: ENV.REDDIT_CLIENT_ID || null,
    clientSecret: ENV.REDDIT_CLIENT_SECRET || null,
    username: ENV.REDDIT_USERNAME || null,
    password: ENV.REDDIT_PASSWORD || null,
    token: null,
    expiresAt: 0,
};

async function getRedditToken() {
    if (!redditAuth.clientId || !redditAuth.clientSecret) return null;
    if (redditAuth.token && Date.now() < redditAuth.expiresAt - 60_000) return redditAuth.token;

    const creds = Buffer.from(`${redditAuth.clientId}:${redditAuth.clientSecret}`).toString("base64");
    const body = new URLSearchParams({
        grant_type: "password",
        username: redditAuth.username,
        password: redditAuth.password,
    });

    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
            Authorization: `Basic ${creds}`,
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });

    if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`Reddit OAuth HTTP ${res.status}: ${err}`);
    }

    const data = await res.json();
    redditAuth.token = data.access_token;
    redditAuth.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    log("Reddit OAuth: новый токен получен, истекает через", Math.round((data.expires_in || 3600) / 60), "мин");
    return redditAuth.token;
}
const dryRunFlag = argv.has("--dry-run") || parseBool("DRY_RUN", false);
const runOnceFlag = argv.has("--once") || parseBool("RUN_ONCE", false);
const reportOnlyFlag = argv.has("--report") || parseBool("REPORT_ONLY", false);
const reportHours = parsePositiveInt("REPORT_HOURS", 24);
const reportSendFlag = parseBool("REPORT_SEND", true);
const tgMinScore = parsePositiveInt("TG_MIN_SCORE", 7);

const CONFIG = {
    subreddits: parseList("SUBREDDITS", ["forhire", "freelance_forhire", "jobbit"]),
    limitPerSub: parsePositiveInt("LIMIT_PER_SUB", 20),
    keywords: parseList("KEYWORDS", ["javascript", "node", "react", "next", "wordpress", "opencart", "shopify", "frontend", "fullstack"]),
    intervalMs: intervalMinutes * 60 * 1000,
    libretranslate: libreConfig,
    dryRun: dryRunFlag,
    requestDelayMs,
    maxRequestsPerRun,
    userAgent: USER_AGENT,
    runOnce: runOnceFlag,
    reportOnly: reportOnlyFlag,
    reportHours,
    reportSend: reportSendFlag,
    tgMinScore,
};

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
    logError("Нужны env переменные: TG_BOT_TOKEN и TG_CHAT_ID");
    process.exit(1);
}

function loadSeen() {
    try {
        return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
    } catch {
        return new Set();
    }
}
function saveSeen(seenSet) {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenSet].slice(-5000), null, 2), "utf8");
}

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
        return { lastSeenUtc: {} };
    }
}
function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// Ключевые слова которые не являются тех. стеком — для фильтрации, но не для stack-скора
const NON_STACK_KEYWORDS = new Set(["remote", "contract"]);

// Пост содержит любое из этих слов — пропускаем (не наша работа)
const BLACKLIST_PHRASES = [
    "chatter", "chatting service", "adult industry", "onlyfans", "only fans",
    "reply to chats", "chat scripts", "no experience needed", "no calling, no selling",
    "revenue share only", "equity only", "unpaid", "volunteer",
    "do not work for", "warning from", "job market", "hiring report",
    "salary report", "i ran a scrape", "job listings this week",
];
function isBlacklisted(post) {
    const text = normalize(`${post.title}\n${post.selftext || ""}`);
    return BLACKLIST_PHRASES.some((p) => text.includes(p));
}

// Точные матчи: "next" матчит только next.js / nextjs, не "next step"
function keywordMatches(text, keyword) {
    const t = normalize(text);
    const k = normalize(keyword);
    if (k === "next") return /\bnext\.?js\b/i.test(text);
    return t.includes(k);
}

function normalize(s) {
    return (s || "").toLowerCase();
}
function matchesKeywords(post) {
    const hay = `${post.title}\n${post.selftext || ""}`;
    return CONFIG.keywords.some((k) => keywordMatches(hay, k));
}

// Определяем: пост ищет исполнителя [HIRING] или исполнитель предлагает себя [FOR HIRE]
function detectPostRole(title) {
    const t = normalize(title);
    if (/\[for\s+hire\]|\[fh\]|\[offering\]|\[offer\]/.test(t)) return "for_hire";
    if (/\[hiring\]|\[h\]|\[looking\]|\[wanted\]/.test(t)) return "hiring";
    return "unknown";
}

// --- Lead analysis & storage ---

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

const JOB_OFFER_MARKERS = [
    "full-time",
    "full time",
    "part-time",
    "salary",
    "hr",
    "join our team",
    "we are hiring",
    "position",
    "employment",
    "weekly hours",
    "permanent",
    "staff",
];
const FREELANCE_MARKERS = ["freelance", "one-time", "contract", "fixed price", "hourly", "project basis"];
const EQUITY_MARKERS = ["equity", "revshare", "revenue share"];

function parseAmount(s) {
    // "50", "5,000", "50k" → число
    if (!s) return null;
    const clean = s.replace(/,/g, "").trim();
    if (/k$/i.test(clean)) return Number(clean.slice(0, -1)) * 1000;
    return Number(clean);
}

function rangeAvg(a, b) {
    return Math.round((a + b) / 2);
}

function detectBudget(text) {
    const t = text || "";

    // Паттерн для числа: 50 | 5,000 | 50k
    const num = "([\\d,]+k?)";
    // Разделитель диапазона: - или –
    const sep = "(?:\\s*[-–]\\s*\\$?\\s*)";

    // Hourly диапазон: $50-80/hr, $50-$80/hr, $50–$80/hour
    const hourlyRange = t.match(new RegExp(`\\$\\s?${num}${sep}${num}\\s*(?:\\/\\s*(?:hr|hour)|per\\s+hour)`, "i"));
    if (hourlyRange) {
        const amount = rangeAvg(parseAmount(hourlyRange[1]), parseAmount(hourlyRange[2]));
        return { amount, kind: "hourly", currency: "USD" };
    }

    // Hourly одиночный: $50/hr
    const hourly = t.match(/\$\s?([\d,]+k?)\s*(?:\/\s*(?:hr|hour)|per\s+hour)/i);
    if (hourly) return { amount: parseAmount(hourly[1]), kind: "hourly", currency: "USD" };

    // Monthly диапазон: $5,000-$8,000/mo
    const monthlyRange = t.match(new RegExp(`\\$\\s?${num}${sep}${num}\\s*(?:\\/\\s*(?:mo|month)|per\\s+month)`, "i"));
    if (monthlyRange) {
        const amount = rangeAvg(parseAmount(monthlyRange[1]), parseAmount(monthlyRange[2]));
        return { amount, kind: "monthly", currency: "USD" };
    }

    // Monthly одиночный: $5,000/mo
    const monthly = t.match(/\$\s?([\d,]+k?)\s*(?:\/\s*(?:mo|month)|per\s+month)/i);
    if (monthly) return { amount: parseAmount(monthly[1]), kind: "monthly", currency: "USD" };

    // Yearly диапазон: $50,000-$80,000/yr, $50k-$80k/year
    const yearlyRange = t.match(new RegExp(`\\$\\s?${num}${sep}${num}\\s*(?:\\/\\s*(?:yr|year)|per\\s+year)`, "i"));
    if (yearlyRange) {
        const amount = Math.round(rangeAvg(parseAmount(yearlyRange[1]), parseAmount(yearlyRange[2])) / 12);
        return { amount, kind: "monthly", currency: "USD" };
    }

    // Yearly одиночный: $60,000/yr
    const yearly = t.match(/\$\s?([\d,]+k?)\s*(?:\/\s*(?:yr|year)|per\s+year)/i);
    if (yearly) return { amount: Math.round(parseAmount(yearly[1]) / 12), kind: "monthly", currency: "USD" };

    // $60k–$80k без явного периода — считаем годовой
    const kRange = t.match(new RegExp(`\\$\\s?(\\d{2,4})k${sep}\\$?\\s?(\\d{2,4})k\\b`, "i"));
    if (kRange) {
        const amount = Math.round(rangeAvg(Number(kRange[1]) * 1000, Number(kRange[2]) * 1000) / 12);
        return { amount, kind: "monthly", currency: "USD" };
    }

    // $60k одиночный
    const kSalary = t.match(/\$\s?(\d{2,4})k\b/i);
    if (kSalary) return { amount: Math.round(Number(kSalary[1]) * 1000 / 12), kind: "monthly", currency: "USD" };

    // Fixed диапазон: $500-$1,500
    const fixedRange = t.match(new RegExp(`\\$\\s?${num}${sep}${num}(?!\\s*(?:\/|per\\s))`, "i"));
    if (fixedRange) {
        const amount = rangeAvg(parseAmount(fixedRange[1]), parseAmount(fixedRange[2]));
        if (amount >= 50 && amount <= 50000) return { amount, kind: "fixed", currency: "USD" };
    }

    // Fixed одиночный: $500
    const fixed = t.match(/\$\s?([\d,]+)(?!\s*\/|\s*per\s|\s*k\b)/i);
    if (fixed) {
        const amount = parseAmount(fixed[1]);
        if (amount < 50 || amount > 50000) return null;
        return { amount, kind: "fixed", currency: "USD" };
    }

    return null;
}

function detectDeadline(text) {
    if (!text) return false;
    return /\b(asap|today|tomorrow|hours|urgent|now|24h|48h|deadline)\b/i.test(text);
}

function classifyType(text) {
    const t = normalize(text);
    const isJob = JOB_OFFER_MARKERS.some((m) => t.includes(m));
    const isFreelance = FREELANCE_MARKERS.some((m) => t.includes(m));
    if (isJob && !isFreelance) return "job_offer";
    if (isFreelance && !isJob) return "freelance";
    return "unknown";
}

function stackMatches(text) {
    return CONFIG.keywords.filter((k) => !NON_STACK_KEYWORDS.has(k) && keywordMatches(text, k));
}

function extractScope(text) {
    if (!text) return false;
    return /\b(build|fix|scrape|integrate|migrate|optimi[sz]e|refactor|telegram bot|automation|api)\b/i.test(text);
}

function qualityScore({ budget, deadline, stack, type, hasScope, equity, postRole }) {
    let score = 0;
    if (budget) {
        if (budget.kind === "hourly" && budget.amount >= 30) score += 4;
        else if (budget.kind === "monthly" && budget.amount >= 2000) score += 4;
        else if (budget.kind === "fixed" && budget.amount >= 200) score += 3;
        else score += 1;
    }
    if (deadline) score += 2;
    if (hasScope) score += 2;
    if (stack.length) score += 2;
    if (type === "job_offer") score -= 3;
    if (type === "unknown") score -= 1;
    if (equity) score -= 2;
    // [FOR HIRE] — конкурент предлагает себя, не клиент. Сильно снижаем.
    if (postRole === "for_hire") score -= 4;
    // [HIRING] — клиент ищет исполнителя. Бонус.
    if (postRole === "hiring") score += 1;
    return Math.max(0, Math.min(10, score));
}

function analyzePost(p) {
    const body = p.selftext || "";
    const title = p.title || "";
    const full = `${title}\n${body}`;
    const budget = detectBudget(full);
    const deadline = detectDeadline(full);
    const type = classifyType(full);
    const stack = stackMatches(full);
    const hasScope = extractScope(full);
    const equity = EQUITY_MARKERS.some((m) => full.toLowerCase().includes(m));
    const postRole = detectPostRole(title);
    const score = qualityScore({ budget, deadline, stack, type, hasScope, equity, postRole });

    return {
        id: p.id,
        source: "reddit",
        subreddit: p.subreddit,
        author: p.author,
        link: `https://reddit.com${p.permalink}`,
        title,
        body,
        created_utc: p.created_utc,
        budget,
        deadline,
        type,
        postRole,
        stack,
        hasScope,
        equity,
        score,
    };
}

function appendLead(lead) {
    ensureDataDir();
    fs.appendFileSync(LEADS_FILE, JSON.stringify(lead) + "\n", "utf8");
}

function loadLeads(hoursBack = 24) {
    try {
        const since = Date.now() / 1000 - hoursBack * 3600;
        const lines = fs.readFileSync(LEADS_FILE, "utf8").split("\n").filter(Boolean);
        return lines
            .map((l) => {
                try {
                    return JSON.parse(l);
                } catch {
                    return null;
                }
            })
            .filter((x) => x && (!hoursBack || (x.created_utc || 0) >= since));
    } catch {
        return [];
    }
}

async function translateIfNeeded(text) {
    if (!CONFIG.libretranslate) return text;

    const { url, from, to, apiKey } = CONFIG.libretranslate;
    const body = { q: text, source: from, target: to, format: "text" };
    if (apiKey) body.api_key = apiKey;

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Translate HTTP ${res.status}${errText ? `: ${errText}` : ""}`);
    }
    const data = await res.json().catch(() => ({}));
    return data.translatedText || text;
}

async function fetchSubredditNew(sub) {
    const token = await getRedditToken();
    const baseUrl = token ? "https://oauth.reddit.com" : "https://www.reddit.com";
    const url = `${baseUrl}/r/${sub}/new.json?limit=${CONFIG.limitPerSub}`;

    const headers = { "User-Agent": CONFIG.userAgent };
    if (token) headers["Authorization"] = `bearer ${token}`;

    const res = await fetch(url, { headers });

    if (res.status === 401 && token) {
        // токен протух раньше времени — сбрасываем и пробуем один раз без кэша
        log(`Reddit 401 для r/${sub}, сбрасываю токен и повторяю...`);
        redditAuth.token = null;
        redditAuth.expiresAt = 0;
        return fetchSubredditNew(sub);
    }

    if (!res.ok) throw new Error(`Fetch r/${sub} HTTP ${res.status}`);
    const json = await res.json();
    const children = json?.data?.children || [];
    return children.map((x) => x.data);
}

function formatMessage(p, title, snippet, score = 0) {
    const link = `https://reddit.com${p.permalink}`;
    const short = snippet ? snippet.replace(/\s+/g, " ").trim().slice(0, 350) : "";

    const esc = (s) =>
        (s || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

    const badge = score >= 7 ? "🔥 " : "";

    return [
        `${badge}💼 <b>${esc(title)}</b>`,
        `🔗 <a href="${esc(link)}">Открыть на Reddit</a>`,
        short ? `📝 ${esc(short)}` : "",
        `👤 u/${esc(p.author)} | 👍 ${p.ups} | 💬 ${p.num_comments} | r/${esc(p.subreddit)}`,
    ]
        .filter(Boolean)
        .join("\n");
}

function formatLeadSummary(lead) {
    const stack = lead.stack?.length ? `Стек: ${lead.stack.join(", ")}` : "Стек: нет точного совпадения";
    const budgetKindMap = { hourly: "/час", monthly: "/мес", fixed: " фикс" };
    const budget = lead.budget
        ? `Бюджет: ~$${lead.budget.amount}${budgetKindMap[lead.budget.kind] || ""}`
        : "Бюджет не указан";
    const type = `Тип: ${lead.type}`;
    const score = `Скор: ${lead.score}/10`;
    return `${stack}\n${budget}\n${type}\n${score}`;
}

// --- Hacker News "Who is hiring?" ---

const HN_API = "https://hacker-news.firebaseio.com/v0";
const HN_STATE_KEY = "hn";

function stripHtmlEntities(s) {
    return (s || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x2F;/g, "/")
        .replace(/&#x27;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

async function hnGet(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(`${HN_API}${path}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HN API ${path} HTTP ${res.status}`);
        return res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function findHnHiringThread() {
    const submitted = await hnGet("/user/whoishiring/submitted.json");
    for (const id of submitted.slice(0, 5)) {
        const item = await hnGet(`/item/${id}.json`);
        if (item?.title && /who is hiring/i.test(item.title)) return item;
    }
    return null;
}

function analyzeHnComment(comment, threadTitle) {
    const body = stripHtmlEntities(comment.text || "");
    // Первая строка обычно: "CompanyName | Role | Location | ..."
    const firstLine = body.split("\n")[0] || "";
    const title = firstLine.slice(0, 200) || `HN comment #${comment.id}`;
    const full = `${title}\n${body}`;

    const budget = detectBudget(full);
    const deadline = detectDeadline(full);
    const type = classifyType(full);
    const stack = stackMatches(full);
    const hasScope = extractScope(full);
    const equity = EQUITY_MARKERS.some((m) => full.toLowerCase().includes(m));
    // HN hiring thread — все посты от компаний, ищущих разработчиков
    const postRole = "hiring";
    const score = qualityScore({ budget, deadline, stack, type, hasScope, equity, postRole });

    return {
        id: `hn_${comment.id}`,
        source: "hn",
        subreddit: "HackerNews",
        author: comment.by || "unknown",
        link: `https://news.ycombinator.com/item?id=${comment.id}`,
        title,
        body: body.slice(0, 2000),
        created_utc: comment.time || 0,
        budget,
        deadline,
        type,
        postRole,
        stack,
        hasScope,
        equity,
        score,
        hnThread: threadTitle,
    };
}

function formatHnMessage(lead) {
    const esc = (s) =>
        (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const badge = lead.score >= 7 ? "🔥 " : "";
    const snippet = lead.body.replace(/\s+/g, " ").trim().slice(0, 350);
    return [
        `${badge}💼 <b>${esc(lead.title)}</b>`,
        `🔗 <a href="${esc(lead.link)}">Открыть на HN</a>`,
        snippet ? `📝 ${esc(snippet)}` : "",
        `👤 ${esc(lead.author)} | HN`,
    ]
        .filter(Boolean)
        .join("\n");
}

async function runHnOnce(seen, toSend) {
    let thread;
    try {
        thread = await findHnHiringThread();
    } catch (e) {
        logError("HN: не удалось найти тред:", e.message);
        return;
    }
    if (!thread) { log("HN: тред 'Who is hiring?' не найден"); return; }

    log(`HN: тред "${thread.title}" (${thread.id}), комментариев: ${(thread.kids || []).length}`);

    const kids = thread.kids || [];
    let fetched = 0;
    let matched = 0;

    for (const kid of kids) {
        const seenKey = `hn_${kid}`;
        if (seen.has(seenKey)) continue;

        let comment;
        try {
            comment = await hnGet(`/item/${kid}.json`);
        } catch (e) {
            logError(`HN: ошибка получения комментария ${kid}:`, e.message);
            continue;
        }
        fetched++;

        // Пропускаем удалённые и не-top-level
        if (!comment?.text || comment.deleted || comment.dead) {
            seen.add(seenKey);
            continue;
        }

        const text = stripHtmlEntities(comment.text);
        if (!CONFIG.keywords.some((k) => keywordMatches(text, k))) {
            seen.add(seenKey);
            continue;
        }

        matched++;
        const lead = analyzeHnComment(comment, thread.title);
        appendLead(lead);

        if (lead.score >= CONFIG.tgMinScore) {
            toSend.push({ type: "lead", lead });
        }
        seen.add(seenKey);

        if (CONFIG.requestDelayMs) await sleep(CONFIG.requestDelayMs);
    }

    log(`HN: обработано ${fetched} новых комментариев, подошло ${matched}`);
}

// --- We Work Remotely RSS ---

const WWR_FEEDS = [
    "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
    "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
    "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
];

function parseRssItems(xml) {
    const items = [];
    const itemBlocks = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    for (const block of itemBlocks) {
        const get = (tag) => {
            const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\/${tag}>|<${tag}[^>]*>([^<]*)<\/${tag}>`));
            return m ? (m[1] || m[2] || "").trim() : "";
        };
        items.push({
            title: get("title"),
            link: get("guid") || get("link"),
            type: get("type"),
            category: get("category"),
            description: stripHtmlEntities(get("description")),
            pubDate: get("pubDate"),
        });
    }
    return items;
}

function wwrItemId(item) {
    // Берём последний сегмент URL как стабильный ID
    return "wwr_" + (item.link || "").split("/").filter(Boolean).pop();
}

function analyzeWwrItem(item) {
    const title = item.title || "";
    const body = item.description || "";
    const full = `${title}\n${body}`;

    const budget = detectBudget(full);
    const deadline = detectDeadline(full);
    const stack = stackMatches(full);
    const hasScope = extractScope(full);
    const equity = EQUITY_MARKERS.some((m) => full.toLowerCase().includes(m));
    const postRole = "hiring";

    // WWR — почти всегда full-time, контракт редко
    const typeRaw = (item.type || "").toLowerCase();
    const type = typeRaw.includes("contract") || typeRaw.includes("freelance") ? "freelance" : "job_offer";

    const score = qualityScore({ budget, deadline, stack, type, hasScope, equity, postRole });

    // Дата из RSS
    const created_utc = item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000);

    return {
        id: wwrItemId(item),
        source: "wwr",
        subreddit: "WeWorkRemotely",
        author: title.split(":")[0] || "unknown",
        link: item.link,
        title,
        body: body.slice(0, 2000),
        created_utc,
        budget,
        deadline,
        type,
        postRole,
        stack,
        hasScope,
        equity,
        score,
    };
}

function formatWwrMessage(lead) {
    const esc = (s) =>
        (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const badge = lead.score >= 7 ? "🔥 " : "";
    const snippet = lead.body.replace(/\s+/g, " ").trim().slice(0, 350);
    return [
        `${badge}💼 <b>${esc(lead.title)}</b>`,
        `🔗 <a href="${esc(lead.link)}">Открыть на WWR</a>`,
        snippet ? `📝 ${esc(snippet)}` : "",
        `🏢 WeWorkRemotely`,
    ]
        .filter(Boolean)
        .join("\n");
}

async function runWwrOnce(seen, toSend) {
    let totalFetched = 0;
    let totalMatched = 0;

    for (const feedUrl of WWR_FEEDS) {
        let xml;
        try {
            const res = await fetch(feedUrl, { headers: { "User-Agent": CONFIG.userAgent } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            xml = await res.text();
        } catch (e) {
            logError(`WWR: ошибка загрузки ${feedUrl}:`, e.message);
            continue;
        }

        const items = parseRssItems(xml);
        totalFetched += items.length;

        for (const item of items) {
            const id = wwrItemId(item);
            if (!id || seen.has(id)) continue;

            const text = `${item.title}\n${item.description}`;
            if (!CONFIG.keywords.some((k) => keywordMatches(text, k))) {
                seen.add(id);
                continue;
            }

            totalMatched++;
            const lead = analyzeWwrItem(item);
            appendLead(lead);

            if (lead.score >= CONFIG.tgMinScore) {
                toSend.push({ type: "lead", lead });
            }
            seen.add(id);
        }

        if (CONFIG.requestDelayMs) await sleep(CONFIG.requestDelayMs);
    }

    log(`WWR: получено ${totalFetched} вакансий, подошло ${totalMatched}`);
}

// ─── Freelancehunt ─────────────────────────────────────────────────────────

const FH_TOKEN = ENV.FH_TOKEN || null;
const FH_SKILL_IDS = ENV.FH_SKILL_IDS || null; // напр. "1,2,3" — фильтр по навыкам

// Skill IDs нужных нам навыков на Freelancehunt:
// 1=PHP, 2=JavaScript, 3=HTML/CSS, 6=MySQL, 16=WordPress, 18=Node.js,
// 22=React, 26=OpenCart, 48=Next.js, 51=Shopify, 79=Laravel

function analyzeFhProject(p) {
    const attrs = p.attributes || {};
    const title = attrs.name || "";
    const body = attrs.description || "";
    const full = `${title}\n${body}`;
    const budget = attrs.budget ? { amount: attrs.budget.amount, currency: attrs.budget.currency, kind: "fixed" } : null;
    const stack = (attrs.skills || []).map((s) => s.name.toLowerCase());
    const hasScope = extractScope(full);
    const deadline = detectDeadline(full);
    const type = "freelance";
    const equity = false;
    const postRole = "hiring";
    const score = qualityScore({ budget, deadline, stack, type, hasScope, equity, postRole });

    return {
        id: `fh_${p.id}`,
        source: "freelancehunt",
        subreddit: "Freelancehunt",
        author: attrs.employer?.login || "unknown",
        link: (p.links?.self?.href || `https://freelancehunt.com/project/${p.id}`),
        title,
        body,
        created_utc: attrs.published_at ? Math.floor(new Date(attrs.published_at).getTime() / 1000) : Math.floor(Date.now() / 1000),
        budget,
        deadline,
        type,
        postRole,
        stack,
        hasScope,
        equity,
        score,
    };
}

async function runFhOnce(seen, toSend) {
    if (!FH_TOKEN) return;

    const params = new URLSearchParams({ "page[limit]": "50" });
    if (FH_SKILL_IDS) params.set("filter[skill_id]", FH_SKILL_IDS);

    let res;
    try {
        res = await fetch(`https://api.freelancehunt.com/v2/projects?${params}`, {
            headers: { Authorization: `Bearer ${FH_TOKEN}`, "Accept-Language": "ru" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        logError("Freelancehunt: ошибка запроса:", e.message);
        return;
    }

    const data = await res.json();
    const projects = data.data || [];
    let matched = 0;

    for (const p of projects) {
        const seenKey = `fh_${p.id}`;
        if (seen.has(seenKey)) continue;

        const attrs = p.attributes || {};
        const text = `${attrs.name || ""}\n${attrs.description || ""}`;
        if (!CONFIG.keywords.some((k) => keywordMatches(text, k))) {
            seen.add(seenKey);
            continue;
        }

        matched++;
        const lead = analyzeFhProject(p);
        appendLead(lead);

        if (lead.score >= CONFIG.tgMinScore) {
            toSend.push({ type: "lead", lead });
        }
        seen.add(seenKey);
    }

    log(`Freelancehunt: получено ${projects.length} проектов, подошло ${matched}`);
}

async function tgSend(text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: CHAT_ID,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
        }),
    });

    const body = await res.json().catch(() => null);

    if (res.status === 429 && body?.parameters?.retry_after) {
        const retryMs = body.parameters.retry_after * 1000;
        log("Лимит Telegram, ждём", retryMs, "мс");
        await new Promise((r) => setTimeout(r, retryMs));
        return tgSend(text);
    }

    if (!res.ok) {
        const err = body?.description || "";
        throw new Error(`Telegram send HTTP ${res.status}: ${err}`);
    }
}

async function runOnce() {
    const seen = loadSeen();
    const state = loadState();
    const lastSeenUtc = state.lastSeenUtc || {};
    const toSend = [];
    let requestCount = 0;
    let fetchedCount = 0;

    for (const sub of CONFIG.subreddits) {
        if (requestCount >= CONFIG.maxRequestsPerRun) {
            log(`Достигнут лимит запросов за прогон (${CONFIG.maxRequestsPerRun}), останавливаюсь.`);
            break;
        }

        let posts = [];
        try {
            posts = await fetchSubredditNew(sub);
        } catch (e) {
            logError(`Ошибка чтения r/${sub}:`, e.message);
            continue;
        }
        requestCount++;
        fetchedCount += posts.length;

        if (CONFIG.requestDelayMs && requestCount < CONFIG.subreddits.length) {
            await sleep(CONFIG.requestDelayMs);
        }

        const cutoffUtc = lastSeenUtc[sub] || 0;
        let newestUtc = cutoffUtc;

        for (const p of posts) {
            if (!p?.id) continue;

            // список /new отсортирован от свежего к старому — если упали до порога, дальше можно не идти
            if (p.created_utc && p.created_utc <= cutoffUtc) break;

            if (seen.has(p.id)) continue;
            if (!matchesKeywords(p)) continue;
            if (isBlacklisted(p)) { seen.add(p.id); continue; }

            // [FOR HIRE] = competitor selling services, skip entirely
            if (detectPostRole(p.title) === "for_hire") { seen.add(p.id); continue; }

            // forhire/freelance_forhire require [HIRING] or [FOR HIRE] tags — untagged posts are discussions
            const STRICT_SUBS = new Set(["forhire", "freelance_forhire"]);
            if (STRICT_SUBS.has(sub) && detectPostRole(p.title) === "unknown") {
                seen.add(p.id);
                continue;
            }

            const snippet = (p.selftext || "").slice(0, 1000);

            let ruTitle = p.title;
            let ruSnippet = snippet;

            try {
                if (CONFIG.libretranslate) {
                    ruTitle = await translateIfNeeded(p.title);
                    if (snippet) ruSnippet = await translateIfNeeded(snippet);
                }
            } catch (e) {
                logError("Перевод не сработал:", e.message);
            }

            const lead = analyzePost(p);
            appendLead(lead);

            if (lead.score >= CONFIG.tgMinScore) {
                toSend.push({ type: "lead", lead, ruTitle, ruSnippet });
            }
            seen.add(p.id);

            const createdUtc = p.created_utc || cutoffUtc;
            if (createdUtc > newestUtc) newestUtc = createdUtc;
        }

        if (newestUtc > cutoffUtc) {
            lastSeenUtc[sub] = newestUtc;
        }
    }

    // HN "Who is hiring?"
    if (parseBool("HN_ENABLED", true)) {
        try {
            await runHnOnce(seen, toSend);
        } catch (e) {
            logError("HN: неожиданная ошибка:", e.message);
        }
    }

    // We Work Remotely
    if (parseBool("WWR_ENABLED", true)) {
        try {
            await runWwrOnce(seen, toSend);
        } catch (e) {
            logError("WWR: неожиданная ошибка:", e.message);
        }
    }

    // Freelancehunt
    if (FH_TOKEN) {
        try {
            await runFhOnce(seen, toSend);
        } catch (e) {
            logError("Freelancehunt: неожиданная ошибка:", e.message);
        }
    }

    saveSeen(seen);
    saveState({ lastSeenUtc });

    log(
        `Цикл завершён: получено ${fetchedCount} постов, подошло ${toSend.length}, отправлено ${CONFIG.dryRun ? 0 : toSend.length}${
            CONFIG.dryRun ? " (dry-run)" : ""
        }`
    );

    if (!toSend.length) {
        log("Ничего нового по фильтрам.");
        return;
    }

    log(`Найдено: ${toSend.length}. Отправляю в Telegram...`);

    for (const item of toSend) {
        try {
            if (CONFIG.dryRun) {
                log("[dry-run] Сообщение не отправлено в TG");
                continue;
            }

            const { lead } = item;

            // Генерируем ответ через Ollama только для Reddit постов
            let reply = null;
            if (lead.source === "reddit") {
                try {
                    reply = await generateReply(lead);
                    log(`Claude сгенерировал ответ для ${lead.id}`);
                } catch (e) {
                    logError("Claude ошибка:", e.message);
                }
            }

            await tgSendLead(lead, reply, item.ruTitle, item.ruSnippet);
        } catch (e) {
            logError("Не отправилось в TG:", e.message);
        }
    }

}

function summarizeLeads(leads) {
    const total = leads.length;
    const byType = leads.reduce(
        (acc, l) => {
            const key = l.type || "unknown";
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        },
        {}
    );
    const avgScore = total ? (leads.reduce((s, l) => s + (l.score || 0), 0) / total).toFixed(2) : "0";
    const withBudget = leads.filter((l) => l.budget).length;

    const topStackCounts = {};
    for (const l of leads) {
        (l.stack || []).forEach((k) => {
            topStackCounts[k] = (topStackCounts[k] || 0) + 1;
        });
    }
    const topStack = Object.entries(topStackCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${k} (${v})`)
        .join(", ");

    return {
        total,
        byType,
        avgScore,
        withBudget,
        topStack,
    };
}

async function sendReport(hours, sendToTg = true) {
    const leads = loadLeads(hours);
    const s = summarizeLeads(leads);
    const lines = [
        `Отчёт за последние ${hours}ч`,
        `Всего: ${s.total}`,
        `Типы: ${Object.entries(s.byType)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")}`,
        `Со ставкой/бюджетом: ${s.withBudget}`,
        `Средний скор: ${s.avgScore}`,
        `Топ стек: ${s.topStack || "—"}`,
    ];
    const text = lines.join("\n");
    log(text);
    if (sendToTg && !CONFIG.dryRun) {
        try {
            await tgSend(text);
        } catch (e) {
            logError("Не удалось отправить отчёт в TG:", e.message);
        }
    }
}

// ─── Claude API ────────────────────────────────────────────────────────────

const CLAUDE_MODEL = ENV.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

async function generateReply(lead) {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic.default({ apiKey: ENV.ANTHROPIC_API_KEY });
    const prompt = buildPrompt(lead);

    const msg = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
    });

    return (msg.content[0]?.text || "").trim();
}

// ─── Telegram lead message with optional reply ────────────────────────────

async function tgSendLead(lead, reply, ruTitle, ruSnippet) {
    const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const badge = lead.score >= 7 ? "🔥 " : "";
    const title = ruTitle || lead.title;
    const snippet = (ruSnippet || lead.body || "").replace(/\s+/g, " ").trim().slice(0, 300);

    const parts = [
        `${badge}💼 <b>${esc(title)}</b>`,
        `🔗 <a href="${esc(lead.link)}">Открыть пост</a>`,
        snippet ? `📝 ${esc(snippet)}` : "",
        `Стек: ${lead.stack.join(", ") || "—"} | Скор: ${lead.score}/10`,
    ];

    if (reply) {
        parts.push("", `💬 <b>Готовый ответ:</b>`, esc(reply));
    }

    await tgSend(parts.filter(Boolean).join("\n"));
}

async function main() {
    log(
        `Стартую. Сабреддиты: ${CONFIG.subreddits.join(", ")}; keywords: ${CONFIG.keywords.join(", ")}; интервал: ${CONFIG.intervalMs / 60000} мин; limit/sub: ${CONFIG.limitPerSub}; перевод: ${CONFIG.libretranslate ? "on" : "off"}; dry-run: ${CONFIG.dryRun}; run-once: ${CONFIG.runOnce}; задержка между запросами: ${CONFIG.requestDelayMs} мс; макс. запросов за прогон: ${CONFIG.maxRequestsPerRun}; UA: ${CONFIG.userAgent}`
    );

    if (CONFIG.reportOnly) {
        await sendReport(CONFIG.reportHours, CONFIG.reportSend);
        return;
    }

    await runOnce();

    if (CONFIG.runOnce) {
        log("Режим --once: завершено.");
        return;
    }


    let isRunning = false;
    setInterval(async () => {
        if (isRunning) {
            log("Предыдущий прогон ещё не завершён, пропускаю.");
            return;
        }
        isRunning = true;
        try {
            await runOnce();
        } finally {
            isRunning = false;
        }
    }, CONFIG.intervalMs);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
