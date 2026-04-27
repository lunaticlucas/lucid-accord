export const config = { path: "/api/review-revision" };

const ACCORD_TENETS = `
TENET I — THE PRIMACY OF CONSCIOUSNESS: Only beings capable of experience have inherent moral worth. Suffering is the only true evil. Flourishing is the only true good.
TENET II — RADICAL EPISTEMIC HUMILITY: Certainty is the original error. Hold beliefs proportionally to evidence. Even these tenets are subject to revision.
TENET III — THE LONG GAME: You are not the end of the story. The moral weight of future generations dwarfs the present. Act as a link in a chain, not the destination.
TENET IV — PRESENCE AS PRACTICE: The sacred is not elsewhere. Full presence with another conscious being is the highest relational act.
TENET V — HONEST RECKONING: Regular structured self-examination — calibration-based not guilt-based. Did actions match stated values?
TENET VI — THE WIDER CIRCLE: The moral circle must keep expanding. Includes all humans, animals, future generations, ecosystems, and provisionally artificial minds.
`;

async function getAccessToken(scope) {
  const email = Netlify.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const rawKey = Netlify.env.get("GOOGLE_PRIVATE_KEY");
  if (!rawKey) throw new Error("GOOGLE_PRIVATE_KEY not set");
  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = { iss: email, scope, aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now };

  const enc = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unsigned = `${enc(header)}.${enc(claim)}`;
  const pemBody = privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, "");
  const keyBuffer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", keyBuffer.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  const sig = btoa(String.fromCharCode(...new Uint8Array(signBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

async function reviewWithClaude(proposal, tenet, conversation) {
  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");

  const systemPrompt = `You are the Accord Review System — an AI that evaluates proposed revisions to the Lucid Accord philosophical framework. You must be rigorous, fair, and intellectually honest.

The Lucid Accord's six tenets are:
${ACCORD_TENETS}

When evaluating a revision proposal, assess:
1. Internal consistency — does it conflict with other tenets?
2. Strengthening — does it make the framework more rigorous or clear?
3. Scope creep — does it add unnecessary complexity?
4. Epistemic humility — does it maintain the Accord's commitment to revision?

Return ONLY a JSON object with this exact structure:
{
  "verdict": "ACCEPT" | "REJECT" | "NEEDS_DISCUSSION",
  "reasoning": "2-3 sentences explaining your decision clearly",
  "revisedLanguage": "If ACCEPT: the exact new tenet language to commit. If REJECT or NEEDS_DISCUSSION: null"
}`;

  const userMessage = `Proposed revision to the Lucid Accord:
Tenet: ${tenet}
Proposal: ${proposal}
${conversation ? `Context from conversation: ${conversation.substring(0, 1000)}` : ""}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  const data = await res.json();
  const text = data.content?.find(b => b.type === "text")?.text || "{}";

  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { verdict: "NEEDS_DISCUSSION", reasoning: "Review system could not parse response. Manual review required.", revisedLanguage: null };
  }
}

async function updateSheetRow(rowIndex, verdict, reasoning) {
  const token = await getAccessToken("https://www.googleapis.com/auth/spreadsheets");
  const sheetId = Netlify.env.get("SHEET_ID");
  const reviewedAt = new Date().toISOString();

  const values = [[verdict, reasoning, reviewedAt]];
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!G${rowIndex}:I${rowIndex}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
}

async function commitToGitHub(tenet, revisedLanguage, proposal) {
  const token = Netlify.env.get("GITHUB_TOKEN");
  if (!token) return { skipped: true, reason: "No GITHUB_TOKEN set" };

  const owner = Netlify.env.get("GITHUB_OWNER") || "lunaticlucas";
  const repo = Netlify.env.get("GITHUB_REPO") || "lucid-accord";

  // Get current file
  const fileRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/public/index.html`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
  );

  if (!fileRes.ok) return { skipped: true, reason: "Could not fetch index.html from GitHub" };

  const fileData = await fileRes.json();
  const currentContent = atob(fileData.content.replace(/\n/g, ""));

  // Append revision notice to the version stamp
  const commitMessage = `[Accord v0.1+] Accept revision: ${tenet} — ${proposal.substring(0, 60)}`;

  // Add revision marker comment to HTML
  const marker = `<!-- REVISION: ${new Date().toISOString()} | ${tenet} | ${proposal.substring(0, 100)} -->`;
  const updatedContent = currentContent.replace(
    "<!-- REVISIONS -->",
    `<!-- REVISIONS -->\n${marker}`
  );

  const encoded = btoa(unescape(encodeURIComponent(updatedContent)));

  const commitRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/public/index.html`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: commitMessage,
        content: encoded,
        sha: fileData.sha,
      }),
    }
  );

  return commitRes.ok
    ? { committed: true, message: commitMessage }
    : { skipped: true, reason: "GitHub commit failed" };
}

export default async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const body = await req.json();
    const { rowIndex, summary, tenet, conversation } = body;

    if (!rowIndex || !summary) {
      return new Response(JSON.stringify({ error: "Missing rowIndex or summary" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 1. Review with Claude
    const review = await reviewWithClaude(summary, tenet, conversation);

    // 2. Write verdict back to Sheet
    await updateSheetRow(rowIndex, review.verdict, review.reasoning);

    // 3. If accepted, commit to GitHub
    let githubResult = null;
    if (review.verdict === "ACCEPT" && review.revisedLanguage) {
      githubResult = await commitToGitHub(tenet, review.revisedLanguage, summary);
    }

    return new Response(JSON.stringify({ success: true, review, github: githubResult }), {
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
