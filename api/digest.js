/* ============================================================
   MORNING DIGEST
   Runs once each weekday morning and sends Paige one notification:
   what's booked, who needs rebooking, anything waiting on her.

   Vercel runs this on a schedule via vercel.json. It can also be
   hit by hand at /api/digest to test.

   Env vars (all already set for push and Square):
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   ============================================================ */

import webpush from "web-push";

const ET = "America/New_York";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date());

const sbHeaders = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
});

async function priv(key) {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/private_data?key=eq.${encodeURIComponent(key)}&select=value`,
    { headers: sbHeaders() }
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0].value : null;
}

async function rows(table, qs) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${qs}`, { headers: sbHeaders() });
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

const prettyTime = (t) => {
  if (!t) return "";
  const [h, m] = String(t).split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hr}:${String(m).padStart(2, "0")}${ampm}` : `${hr}${ampm}`;
};

export default async function handler(req, res) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv2 = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv2 || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Not configured" });
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:paige@example.com", pub, priv2);

  try {
    const day = today();
    const events = (await priv("events")) || [];
    const clients = (await priv("clients")) || [];

    const booked = events
      .filter((e) => e.date === day && !e.noShow)
      .sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));

    /* who hasn't been in for three weeks */
    const stale = clients.filter((c) => {
      const last = (c.history || []).reduce((m, v) => (v.date > m ? v.date : m), "");
      if (!last) return false;
      return (Date.now() - new Date(last + "T12:00")) / 86400000 >= 21;
    }).length;

    const waiting = (await rows("client_requests", "select=id&handled=eq.false")).length;
    const newReviews = (await rows("reviews", "select=id&approved=eq.false")).length;

    /* nothing worth buzzing her for */
    if (!booked.length && !stale && !waiting && !newReviews) {
      return res.status(200).json({ ok: true, skipped: "quiet day" });
    }

    const firstUp = booked[0];
    const lines = [];
    if (booked.length) {
      lines.push(`${booked.length} booked${firstUp ? `, first at ${prettyTime(firstUp.time)}` : ""}`);
    } else {
      lines.push("Nothing booked today");
    }
    if (waiting) lines.push(`${waiting} waiting on you`);
    if (newReviews) lines.push(`${newReviews} review${newReviews === 1 ? "" : "s"} to publish`);
    if (stale) lines.push(`${stale} to rebook`);

    const subs = await rows("push_subs", "select=*");
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({
            title: "Good morning ☀️",
            body: lines.join(" · "),
            url: "/?hq=1",
            tag: "digest",
          })
        );
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
            { method: "DELETE", headers: sbHeaders() });
        }
      }
    }));

    return res.status(200).json({ ok: true, sent, summary: lines.join(" · ") });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Digest failed", detail: String(e) });
  }
}
