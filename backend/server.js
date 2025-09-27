require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();

// CORS
const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!allowed.length || allowed.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  }
}));

// Health
app.get("/", (_req, res) => res.send("OK"));

// Simple cache (1 hour)
const CACHE_TTL_MS = 60 * 60 * 1000;
const userCache = new Map(); // login -> {data, ts}

// Twitch creds from Railway Variables
const cred = { id: process.env.CLIENT_ID_1, secret: process.env.CLIENT_SECRET_1 };
let tokenCache = { token: null, exp: 0 };

async function getAppToken() {
  if (tokenCache.token && tokenCache.exp > Date.now()) return tokenCache.token;
  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cred.id,
      client_secret: cred.secret,
      grant_type: "client_credentials"
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Failed to get Twitch token");
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return tokenCache.token;
}

// GET /api/twitch/users?login=a&login=b
app.get("/api/twitch/users", async (req, res) => {
  let logins = []
    .concat(req.query.login || [])
    .flatMap(v => Array.isArray(v) ? v : [v])
    .flatMap(s => String(s).split(","))
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  if (!logins.length) return res.status(400).json({ error: "login required" });
  logins = [...new Set(logins)].slice(0, 100);

  // Serve cache hits
  const hits = [];
  const misses = [];
  for (const l of logins) {
    const c = userCache.get(l);
    if (c && Date.now() - c.ts < CACHE_TTL_MS) hits.push(c.data);
    else misses.push(l);
  }
  if (!misses.length) return res.json({ data: hits });

  try {
    const token = await getAppToken();
    const url = new URL("https://api.twitch.tv/helix/users");
    misses.forEach(l => url.searchParams.append("login", l));

    const tr = await fetch(url.toString(), {
      headers: { "Client-ID": cred.id, "Authorization": `Bearer ${token}` }
    });
    if (!tr.ok) {
      const t = await tr.text();
      console.error("Twitch error", tr.status, t);
      return res.status(tr.status).json({ error: "twitch_error" });
    }
    const j = await tr.json();

    const fresh = (j.data || []).map(u => ({
      id: u.id,
      login: u.login,
      display_name: u.display_name,
      profile_image_url: u.profile_image_url
    }));
    for (const u of fresh) userCache.set(u.login.toLowerCase(), { data: u, ts: Date.now() });

    res.json({ data: [...hits, ...fresh] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));