export const config = { path: "/api/get-revisions" };

async function getAccessToken() {
  const email = Netlify.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const rawKey = Netlify.env.get("GOOGLE_PRIVATE_KEY");
  if (!rawKey) throw new Error("GOOGLE_PRIVATE_KEY not set");
  if (!email) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL not set");
  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const enc = (obj) =>
    btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const unsigned = `${enc(header)}.${enc(claim)}`;
  const pemBody = privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, "");
  const keyBuffer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", keyBuffer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const signBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", cryptoKey,
    new TextEncoder().encode(unsigned)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(signBuffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const jwt = `${unsigned}.${sig}`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("Token fetch failed: " + JSON.stringify(tokenData));
  return tokenData.access_token;
}

export default async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const token = await getAccessToken();
    const sheetId = Netlify.env.get("SHEET_ID");

    // Read all data from Sheet1 columns A-I (including verdict columns)
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:I`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "Sheets read failed");
    }

    const data = await res.json();
    const rows = data.values || [];

    // Skip header row, map to objects
    const revisions = rows.slice(1).map((row, index) => ({
      rowIndex: index + 2, // 1-based, skip header
      timestamp: row[0] || "",
      alias: row[1] || "Anonymous",
      tenet: row[2] || "General",
      summary: row[3] || "",
      conversation: row[4] || "",
      mode: row[5] || "",
      verdict: row[6] || "PENDING",
      reasoning: row[7] || "",
      reviewedAt: row[8] || "",
    }));

    return new Response(JSON.stringify({ revisions }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
};
