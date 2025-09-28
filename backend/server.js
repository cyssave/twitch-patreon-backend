require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

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

// ---------- Patreon OAuth (issues a premium JWT) ----------

app.use(bodyParser.json());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let stateStore = {}; // Store states temporarily (in-memory for simplicity)

app.get("/", (req, res) => {
  res.sendStatus(200);  // Just respond with a 200 status and no content
});

// Step 1: Redirect users to Patreon for login
app.get("/start-oauth", (req, res) => {
  // Generate a random state
  const state = crypto.randomBytes(16).toString("hex"); // Use crypto to generate a secure random state
  stateStore[state] = true; // Store the state temporarily

  // Redirect user to Patreon OAuth with the state parameter
  const patreonAuthURL = `https://www.patreon.com/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=identity+identity%5Bemail%5D&state=${state}`;

  res.redirect(patreonAuthURL);
});

// Step 2: Handle the Patreon callback
app.get('/oauth-callback', async (req, res) => {
    const code = req.query.code; // The authorization code from Patreon
    const receivedState = req.query.state; // The state parameter sent back with the callback

    // Step 2A: Validate the state
    if (!stateStore[receivedState]) {
        return res.status(400).send('Invalid state received'); // Reject the request if the state is invalid
    }

    // Clean up the state from store after validation
    delete stateStore[receivedState];

    if (!code) {
        return res.status(400).send('No authorization code received');
    }

    try {
        // Step 3 - Exchange the authorization code for an access token
        const tokenResponse = await axios.post('https://www.patreon.com/api/oauth2/token', null, {
            params: {
                grant_type: 'authorization_code',
                code: code,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: REDIRECT_URI
            }
        });

        const accessToken = tokenResponse.data.access_token;

         // Step 4 - Fetch user data from Patreon
        const userResponse = await axios.get(
            'https://www.patreon.com/api/oauth2/v2/identity?include=memberships&fields[user]=full_name,email,image_url&fields[member]=patron_status,currently_entitled_amount_cents',
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const memberships = userResponse.data.included || [];
        console.log("🔍 Raw Membership Data:", JSON.stringify(memberships, null, 2)); // Debugging


        // ✅ Extract user details
        const userData = userResponse.data.data.attributes || {};
        const imageUrl = userData.image_url || '';

        // ✅ Extract membership details
        const activeMembership = memberships.find(m => 
            m.type === "member" && m.attributes && m.attributes.patron_status
        );

        const patronStatus = activeMembership ? activeMembership.attributes.patron_status : null;
        console.log("📢 Membership Status:", patronStatus);

        // ✅ Determine user tier
        const userTier = patronStatus === "active_patron" ? "HigherImp" : "LowerImp";

        // ✅ Send data back to the extension
        res.send(`
            <script>
                window.opener.postMessage({
                    type: 'auth-complete',
                    data: {
                        tier: '${userTier}',
                        user: '${userData.full_name || ''}',
                        email: '${userData.email || ''}',
                        photo: '${imageUrl}',
                        token: '${accessToken}'
                    }
                }, '*');
                window.close();
            </script>
        `);
    } catch (error) {
        console.error("❌ OAuth Callback Error:", error.response ? error.response.data : error.message);
        res.status(500).send("Error during Patreon authentication.");
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));