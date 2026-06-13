const fs = require("fs");
const path = require("path");
const express = require("express");
require("dotenv").config();

const PORT = process.env.DASHBOARD_PORT || 4000;
const DATA_DIR = path.join(__dirname, "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.jsonl");
const STATUSES_FILE = path.join(DATA_DIR, "statuses.json");

function loadStatuses() {
    try { return JSON.parse(fs.readFileSync(STATUSES_FILE, "utf8")); } catch { return {}; }
}
function saveStatuses(s) {
    fs.writeFileSync(STATUSES_FILE, JSON.stringify(s, null, 2), "utf8");
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

function loadLeads(hoursBack = null) {
    try {
        const since = hoursBack ? Date.now() / 1000 - hoursBack * 3600 : 0;
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

function summarize(leads) {
    const total = leads.length;
    if (!total) return { total: 0, hot: 0, hiring: 0, withBudget: 0, avgScore: 0, avgHourly: 0, byScore: [], bySource: [], topStack: [], topSub: [] };

    // Score buckets
    const hot      = leads.filter(l => (l.score || 0) >= 7).length;
    const mid      = leads.filter(l => (l.score || 0) >= 5 && (l.score || 0) < 7).length;
    const low      = total - hot - mid;
    const byScore  = [{ label: "🔥 7-10", count: hot }, { label: "⚡ 5-6", count: mid }, { label: "💤 0-4", count: low }];

    // Роли
    const hiring   = leads.filter(l => l.postRole === "hiring").length;
    const forHire  = leads.filter(l => l.postRole === "for_hire").length;

    // Бюджеты
    const withBudget = leads.filter(l => l.budget).length;
    const hourlyLeads = leads.filter(l => l.budget?.kind === "hourly");
    const avgHourly = hourlyLeads.length
        ? Math.round(hourlyLeads.reduce((s, l) => s + l.budget.amount, 0) / hourlyLeads.length)
        : 0;
    const fixedLeads = leads.filter(l => l.budget?.kind === "fixed");
    const avgFixed = fixedLeads.length
        ? Math.round(fixedLeads.reduce((s, l) => s + l.budget.amount, 0) / fixedLeads.length)
        : 0;

    // Avg score
    const avgScore = Number((leads.reduce((s, l) => s + (l.score || 0), 0) / total).toFixed(1));

    // По источникам
    const srcCounts = {};
    leads.forEach(l => { srcCounts[l.source || "reddit"] = (srcCounts[l.source || "reddit"] || 0) + 1; });
    const bySource = Object.entries(srcCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ source: k, count: v }));

    // Топ стек (без non-stack keywords)
    const NON_STACK = new Set(["remote", "contract"]);
    const stackCounts = {};
    leads.forEach(l => (l.stack || []).filter(s => !NON_STACK.has(s)).forEach(s => { stackCounts[s] = (stackCounts[s] || 0) + 1; }));
    const topStack = Object.entries(stackCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ stack: k, count: v }));

    // Топ сабреддиты с качеством
    const subMap = {};
    leads.forEach(l => {
        const s = l.subreddit || "unknown";
        if (!subMap[s]) subMap[s] = { count: 0, hot: 0 };
        subMap[s].count++;
        if ((l.score || 0) >= 7) subMap[s].hot++;
    });
    const topSub = Object.entries(subMap).sort((a, b) => b[1].count - a[1].count).slice(0, 6)
        .map(([k, v]) => ({ subreddit: k, count: v.count, hot: v.hot }));

    return { total, hot, mid, low, hiring, forHire, withBudget, avgScore, avgHourly, avgFixed, byScore, bySource, topStack, topSub };
}

app.get("/api/leads", (req, res) => {
    const hours = req.query.hours ? Number(req.query.hours) : null;
    const minScore = req.query.minScore ? Number(req.query.minScore) : 0;
    const type = req.query.type;
    const role = req.query.role;
    const limit = req.query.limit ? Number(req.query.limit) : 200;

    const sortBy = req.query.sortBy || "score";
    const sortDir = req.query.sortDir === "asc" ? -1 : 1;

    let leads = loadLeads(hours);
    const statusFilter = req.query.statusFilter;
    const allStatuses = loadStatuses();

    leads = leads
        .filter((l) => (type ? l.type === type : true))
        .filter((l) => (role ? (l.postRole || "unknown") === role : true))
        .filter((l) => (minScore ? (l.score || 0) >= minScore : true))
        .filter((l) => (statusFilter ? (allStatuses[l.id] || "new") === statusFilter : true))
        .sort((a, b) => {
            const numSort = (av, bv) => sortDir * (bv - av);
            const strSort = (av, bv) => sortDir * (bv > av ? -1 : bv < av ? 1 : 0);
            if (sortBy === "score")     return numSort(a.score || 0, b.score || 0);
            if (sortBy === "budget")    return numSort(a.budget?.amount || 0, b.budget?.amount || 0);
            if (sortBy === "date")      return numSort(a.created_utc || 0, b.created_utc || 0);
            if (sortBy === "status")    return strSort(allStatuses[a.id] || "new", allStatuses[b.id] || "new");
            if (sortBy === "type")      return strSort(a.type || "", b.type || "");
            if (sortBy === "role")      return strSort(a.postRole || "", b.postRole || "");
            if (sortBy === "stack")     return strSort((a.stack||[])[0] || "", (b.stack||[])[0] || "");
            if (sortBy === "title")     return strSort(a.title || "", b.title || "");
            if (sortBy === "subreddit") return strSort(a.subreddit || "", b.subreddit || "");
            return numSort(a.score || 0, b.score || 0);
        })
        .slice(0, limit);

    leads.forEach(l => { l.status = allStatuses[l.id] || "new"; });

    res.json({ leads });
});

app.post("/api/status", (req, res) => {
    const { id, status } = req.body;
    const VALID = new Set(["new", "viewed", "applied", "pass"]);
    if (!id || !VALID.has(status)) return res.status(400).json({ error: "bad request" });
    const statuses = loadStatuses();
    statuses[id] = status;
    saveStatuses(statuses);
    res.json({ ok: true });
});

app.get("/api/stats", (req, res) => {
    const hours = req.query.hours ? Number(req.query.hours) : null;
    const leads = loadLeads(hours);
    res.json(summarize(leads));
});

app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
});
