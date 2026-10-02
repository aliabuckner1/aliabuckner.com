// The shared high-score board for aliabuckner.com: a Cloudflare Worker in front of a D1 database.
//   GET  /scores?game=hoop|words   the top 10
//   POST /scores                   { game, name, score }
// Kept simple on purpose: a first name and a sensible number. (Checking scores properly, like recounting word-game
// words, can come later if the board ever gets busy; any entry can be deleted from the database.)

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
    "access-control-allow-headers": "content-type",
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
