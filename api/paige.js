/*  Anthropic proxy — keeps the API key on the server, never in the browser.
    Add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables.
    Powers: receipt scanning and the Advisor chat.                        */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "No API key set yet. Add ANTHROPIC_API_KEY in Vercel and redeploy.",
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: body.model || "claude-sonnet-4-6",
        max_tokens: body.max_tokens || 1000,
        messages: body.messages || [],
      }),
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Request failed", detail: String(err) });
  }
}
