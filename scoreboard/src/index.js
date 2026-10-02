// The shared high-score board and the visit stats for aliabuckner.com: a Cloudflare Worker in front of a D1 database.
//   GET  /scores?game=hoop|words   the top 10
//   POST /scores                   { game, name, score }
//   POST /e                        one stats event from the site (sent with sendBeacon, so it's plain text JSON)
//   GET  /stats                    everything the dashboard shows (needs the secret key in an x-key header)
//   GET  /dashboard                the private dashboard page (the key lives in the link's #hash, never sent here)
// Kept simple on purpose: a first name and a sensible number. (Checking scores properly, like recounting word-game
// words, can come later if the board ever gets busy; any entry can be deleted from the database.)

import DASHBOARD from "./dashboard.html";

const ORIGINS = new Set([
  "https://aliabuckner.com",
  "https://www.aliabuckner.com",
  "http://localhost:8766",
  "http://192.168.68.109:8766",
]);
const TOP = 10;
const NAME_MAX = 10;

const json = (data, status, origin) => new Response(status === 204 ? null : JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": ORIGINS.has(origin) ? origin : "https://aliabuckner.com",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-key",
    "vary": "origin",
  },
});

const top = async (env, game) => {
  const { results } = await env.DB.prepare(
    "SELECT id, name, score, created_at FROM scores WHERE game = ? ORDER BY score DESC, created_at ASC LIMIT ?"
  ).bind(game, TOP).all();
  return results;
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get("origin") || "";
    if (req.method === "OPTIONS") return json({}, 204, origin);
    if (url.pathname === "/e" && req.method === "POST") return logEvent(req, env);
    if (url.pathname === "/stats") return stats(req, env, url, origin);
    if (url.pathname === "/names" && req.method === "POST") return nameVisitor(req, env, origin);
    if (url.pathname === "/dashboard") return new Response(DASHBOARD, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
    if (url.pathname !== "/scores") return json({ error: "not found" }, 404, origin);

    if (req.method === "GET") {
      const game = url.searchParams.get("game");
      if (game !== "hoop" && game !== "words") return json({ error: "which game?" }, 400, origin);
      return json({ top: await top(env, game) }, 200, origin);
    }

    if (req.method !== "POST") return json({ error: "method" }, 405, origin);
    let body;
    try { body = await req.json(); } catch (e) { return json({ error: "bad request" }, 400, origin); }
    const game = body.game, score = Number(body.score);
    // a first name: letters from any language, plus spaces, hyphens, apostrophes and dots, up to NAME_MAX long
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    if (game !== "hoop" && game !== "words") return json({ error: "which game?" }, 400, origin);
    if (!/^\p{L}[\p{L}\p{M} '’.-]*$/u.test(name) || [...name].length > NAME_MAX) return json({ error: "just your first name" }, 400, origin);
    if (!Number.isInteger(score) || score < 1 || score > 9999) return json({ error: "that score doesn't add up" }, 400, origin);

    const row = await env.DB.prepare(
      "INSERT INTO scores (game, name, score, created_at) VALUES (?, ?, ?, ?) RETURNING id"
    ).bind(game, name, score, Date.now()).first();
    return json({ id: row.id, top: await top(env, game) }, 200, origin);
  },
};

// ---- visit stats ------------------------------------------------------------------------------------------------
const EVENT_NAME = /^[a-z_]{1,24}$/, ID = /^[a-z0-9]{6,40}$/;

async function logEvent(req, env) {
  let b;
  try { b = JSON.parse(await req.text()); } catch (e) { return new Response(null, { status: 400 }); }
  if (!b || !EVENT_NAME.test(b.event || "") || !ID.test(b.visitor || "") || !ID.test(b.visit || "")) return new Response(null, { status: 400 });
  const cf = req.cf || {};
  let data = b.data == null ? null : JSON.stringify(b.data);
  if (data && data.length > 800) data = data.slice(0, 800);
  const clip = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));
  await env.DB.prepare(
    "INSERT INTO events (ts, host, visitor, visit, event, data, label, device, country, city, network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(Date.now(), clip(b.host, 60), b.visitor, b.visit, b.event, data, clip(b.label, 12), clip(b.device, 12),
    clip(cf.country, 4), clip(cf.city, 60), clip(cf.asOrganization, 80)).run();
  // a device that's just been labelled (?me=alia) takes its earlier, unlabelled visits along with it
  if (b.label && b.event === "visit") {
    await env.DB.prepare("UPDATE events SET label = ? WHERE visitor = ? AND (label IS NULL OR label = '')").bind(clip(b.label, 12), b.visitor).run();
  }
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
}

// everything the dashboard needs in one go. ?days=N (0 = all time), ?labelled=1 counts the named devices (Alia's,
// her dad's...) in with everyone else, ?test=1 includes events from the test page (localhost and the home network)
async function stats(req, env, url, origin) {
  // the dashboard's password (set by Alia with `npx wrangler secret put DASH_PASSWORD`), or the older secret-link key;
  // a wrong one waits a moment before answering, so guessing is slow
  const given = req.headers.get("x-key") || "";
  const ok = (env.DASH_PASSWORD && given === env.DASH_PASSWORD) || (env.DASH_KEY && given === env.DASH_KEY);
  if (!ok) { await new Promise((r) => setTimeout(r, 1500)); return json({ error: "no" }, 401, origin); }
  return statsFor(env, url, origin);
}
async function authorised(req, env) {
  const given = req.headers.get("x-key") || "";
  return (env.DASH_PASSWORD && given === env.DASH_PASSWORD) || (env.DASH_KEY && given === env.DASH_KEY);
}

// giving a visitor a name (or clearing it with an empty one); dashboard only
async function nameVisitor(req, env, origin) {
  if (!(await authorised(req, env))) { await new Promise((r) => setTimeout(r, 1500)); return json({ error: "no" }, 401, origin); }
  let b;
  try { b = await req.json(); } catch (e) { return json({ error: "bad request" }, 400, origin); }
  const visitor = String(b.visitor || ""), name = String(b.name || "").trim().slice(0, 24);
  if (!ID.test(visitor)) return json({ error: "which visitor?" }, 400, origin);
  if (name) await env.DB.prepare("INSERT INTO names (visitor, name, updated) VALUES (?, ?, ?) ON CONFLICT(visitor) DO UPDATE SET name = excluded.name, updated = excluded.updated").bind(visitor, name, Date.now()).run();
  else await env.DB.prepare("DELETE FROM names WHERE visitor = ?").bind(visitor).run();
  return json({ ok: true }, 200, origin);
}

async function statsFor(env, url, origin) {
  const days = Math.max(0, Number(url.searchParams.get("days") ?? 30) || 0);
  const since = days ? Date.now() - days * 86_400_000 : 0;
  const labelled = url.searchParams.get("labelled") === "1", test = url.searchParams.get("test") === "1";
  // demo=1 shows only the made-up demo visitors (ids start with "demo"), moved forward in time so the newest one is
  // always "just now"; otherwise the demo visitors are left out entirely
  const demo = url.searchParams.get("demo") === "1";
  let shift = 0;
  if (demo) {
    const last = await env.DB.prepare("SELECT MAX(ts) AS t FROM events WHERE visitor LIKE 'demo%'").first();
    shift = last && last.t ? Date.now() - 60_000 - last.t : 0;
  }
  const where = ["ts >= ?", demo ? "visitor LIKE 'demo%'" : "visitor NOT LIKE 'demo%'"], args = [since - shift];
  if (!test && !demo) where.push("host IN ('aliabuckner.com', 'www.aliabuckner.com')");
  if (!labelled) where.push("(label IS NULL OR label = '')");
  const W = where.join(" AND ");
  const all = async (sql, ...extra) => (await env.DB.prepare(sql).bind(...args, ...extra).all()).results;

  const rows = await all(`SELECT ts + ${shift} AS ts, visitor, visit, event, data, label, device, country, city, network FROM events WHERE ${W} ORDER BY ts`);
  // the named devices are always summarised on their own, whatever the filter
  const named = (await env.DB.prepare(
    `SELECT label, COUNT(DISTINCT visit) AS visits, MAX(ts) + ${shift} AS last FROM events WHERE ts >= ? AND ${demo ? "visitor LIKE 'demo%'" : "visitor NOT LIKE 'demo%'"} AND label IS NOT NULL AND label != '' GROUP BY label`
  ).bind(since - shift).all()).results;
  const names = Object.fromEntries((await env.DB.prepare("SELECT visitor, name FROM names").all()).results.map((r) => [r.visitor, r.name]));
  return json({ days, labelled, test, demo, now: Date.now(), rows, named, names }, 200, origin);
}
