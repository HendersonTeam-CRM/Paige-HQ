/* ============================================================
   PUSH NOTIFICATIONS

   POST /api/push  { action: "save",   sub, label }   → remember a device
   POST /api/push  { action: "remove", endpoint }     → forget a device
   POST /api/push  { action: "test" }                 → send a test
   POST /api/push  { action: "notify", kind }         → alert her about a
                                                        new request or review

   "notify" is called by the client site right after someone sends a
   request or leaves a review. It refuses to send unless a matching row
   actually landed in the last two minutes, so it can't be used to spam.

   Vercel env vars:
     VAPID_PUBLIC_KEY        also set as VITE_VAPID_PUBLIC_KEY for the app
     VAPID_PRIVATE_KEY
     VAPID_SUBJECT           mailto:you@example.com
     SUPABASE_URL
     SUPABASE_SERVICE_ROLE_KEY
   ============================================================ */

import webpush from "web-push";

const sbHeaders = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
});

async function subs() {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/push_subs?select=*`, { headers: sbHeaders() });
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

async function saveSub(sub, label) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/push_subs`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      endpoint: sub.endpoint,
      p256dh: sub.keys?.p256dh || "",
      auth: sub.keys?.auth || "",
      label: label || "",
    }),
  });
}

async function dropSub(endpoint) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: "DELETE",
    headers: sbHeaders(),
  });
}

/* only alert on something that genuinely just happened */
async function recentlyHappened(kind) {
  const since = new Date(Date.now() - 120000).toISOString();
  const table = kind === "review" ? "reviews" : "client_requests";
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/${table}?select=*&created_at=gte.${since}&order=created_at.desc&limit=1`,
    { headers: sbHeaders() }
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fanOut(payload) {
  const list = await subs();
  if (!list.length) return { sent: 0, gone: 0 };
  let sent = 0, gone = 0;

  await Promise.all(list.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (e) {
      // 404/410 means that device unsubscribed or the app was deleted
      if (e.statusCode === 404 || e.statusCode === 410) { await dropSub(s.endpoint); gone++; }
      else console.error("push failed:", e.statusCode, e.body);
    }
  }));

  return { sent, gone };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Notifications aren't configured yet." });
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:paige@example.com", pub, priv);

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const action = body.action || "";

  try {
    if (action === "save") {
      if (!body.sub?.endpoint) return res.status(400).json({ error: "no subscription" });
      await saveSub(body.sub, body.label);
      return res.status(200).json({ ok: true });
    }

    if (action === "remove") {
      if (body.endpoint) await dropSub(body.endpoint);
      return res.status(200).json({ ok: true });
    }

    if (action === "test") {
      const out = await fanOut({
        title: "Paige HQ",
        body: "Notifications are on \u2014 you'll hear from me when something needs you.",
        url: "/?hq=1",
        tag: "test",
      });
      return res.status(200).json({ ok: true, ...out });
    }

    if (action === "notify") {
      const kind = body.kind === "review" ? "review" : "request";
      const row = await recentlyHappened(kind);
      if (!row) return res.status(200).json({ ok: false, skipped: "nothing new" });

      const payload = kind === "review"
        ? {
            title: "New review \u2605",
            body: `${row.name || "Someone"} left ${row.rating || 5} stars \u2014 tap to publish it.`,
            url: "/?hq=1",
            tag: "review",
          }
        : {
            title:
              row.kind === "waitlist" ? "Someone wants a sooner spot"
              : row.kind === "reschedule" ? "Someone wants to move a time"
              : "A client has a question",
            body: `${row.name || "A client"}${row.note ? ": " + String(row.note).slice(0, 90) : ""}`,
            url: "/?hq=1",
            tag: "request",
          };

      const out = await fanOut(payload);
      return res.status(200).json({ ok: true, ...out });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Push failed", detail: String(e) });
  }
}
