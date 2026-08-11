/* ============================================================
   SQUARE → PAIGE HQ
   One endpoint, two jobs:

   POST /api/square           → Square's webhook fires here whenever
                                a booking or payment changes
   GET  /api/square?sync=1    → pulls the next 60 days of bookings on
                                demand (the "Sync Square" button)

   Vercel → Settings → Environment Variables:
     SQUARE_ACCESS_TOKEN          production access token
     SQUARE_WEBHOOK_KEY           webhook signature key (webhook only)
     SQUARE_LOCATION_ID           her Square location id
     SUPABASE_URL                 same project URL
     SUPABASE_SERVICE_ROLE_KEY    service role key — SERVER ONLY, never
                                  in a VITE_ variable
   ============================================================ */

import crypto from "crypto";

const SQ = "https://connect.squareup.com/v2";
const sqHeaders = () => ({
  "Square-Version": "2025-01-23",
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
});

/* ---------- tiny Supabase REST helpers (service role) ---------- */
async function sbGet(key) {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/private_data?key=eq.${encodeURIComponent(key)}&select=value`,
    { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0].value : null;
}

async function sbPut(key, value) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/private_data`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key, value }),
  });
}

/* ---------- shaping a Square booking into one of her events ---------- */
const EASTERN = "America/New_York";

/* Square wants RFC 3339 and is fussy about fractional seconds */
const rfc = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");

function localParts(iso) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: EASTERN, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: EASTERN, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return { date, time };
}

/* Velvet Glow vs Pageant Perfect, guessed from the service name */
function classify(name = "") {
  const n = name.toLowerCase();
  if (/(glow|tan|bronz|airbrush)/.test(n)) return { type: "tan", title: name || "Velvet Glow" };
  if (/(dance)/.test(n)) return { type: "dance", title: name || "Dance lesson" };
  return { type: "lesson", title: name || "Private Coaching" };
}

async function customerName(id) {
  if (!id) return "";
  try {
    const r = await fetch(`${SQ}/customers/${id}`, { headers: sqHeaders() });
    const j = await r.json();
    const c = j.customer || {};
    return [c.given_name, c.family_name].filter(Boolean).join(" ").trim();
  } catch { return ""; }
}

async function serviceName(variationId) {
  if (!variationId) return "";
  try {
    const r = await fetch(`${SQ}/catalog/object/${variationId}?include_related_objects=true`, { headers: sqHeaders() });
    const j = await r.json();
    const parentId = j.object?.item_variation_data?.item_id;
    const parent = (j.related_objects || []).find((o) => o.id === parentId);
    const item = parent?.item_data?.name || "";
    const variation = j.object?.item_variation_data?.name || "";
    return [item, variation].filter(Boolean).join(" · ");
  } catch { return ""; }
}

async function toEvent(b) {
  const seg = (b.appointment_segments || [])[0] || {};
  const svc = await serviceName(seg.service_variation_id);
  const { type, title } = classify(svc);
  const { date, time } = localParts(b.start_at);
  return {
    id: "sq_" + b.id,
    square: true,
    type,
    title,
    clientName: await customerName(b.customer_id),
    date,
    time,
    durMin: seg.duration_minutes || 30,
    notes: b.customer_note || "",
    status: b.status,
  };
}

/* ---------- merge into her events list, never clobbering manual ones ---------- */
async function upsertEvents(newOnes) {
  const events = (await sbGet("events")) || [];
  const byId = new Map(events.map((e) => [e.id, e]));
  let added = 0, updated = 0, removed = 0;

  for (const ev of newOnes) {
    const cancelled = ev.status === "CANCELLED_BY_CUSTOMER" || ev.status === "CANCELLED_BY_SELLER";
    if (cancelled) {
      if (byId.delete(ev.id)) removed++;
      continue;
    }
    if (ev.status === "NO_SHOW") {
      // keep it, flagged — a no-show is worth remembering
      const prev = byId.get(ev.id) || ev;
      byId.set(ev.id, { ...prev, ...ev, noShow: true, title: ev.title });
      updated++;
      continue;
    }
    if (byId.has(ev.id)) {
      const prev = byId.get(ev.id);
      byId.set(ev.id, { ...prev, ...ev, notes: prev.notes || ev.notes });
      updated++;
    } else {
      byId.set(ev.id, ev);
      added++;
    }
  }

  await sbPut("events", [...byId.values()]);
  return { added, updated, removed };
}

/* ---------- payments become income ---------- */
/* what was actually bought — used to name the sale and split the business */
async function orderDetail(orderId) {
  if (!orderId) return { name: "", biz: "" };
  try {
    const r = await fetch(`${SQ}/orders/${orderId}`, { headers: sqHeaders() });
    const j = await r.json();
    const items = (j.order?.line_items || []).map((li) => li.name).filter(Boolean);
    const name = items.join(", ");
    const biz = /(glow|tan|airbrush|bronz)/i.test(name) ? "VG" : /(coach|lesson|pageant|interview|walk)/i.test(name) ? "PP" : "";
    return { name, biz };
  } catch { return { name: "", biz: "" }; }
}

async function recordPayment(p) {
  if (!p || p.status !== "COMPLETED") return false;
  const income = (await sbGet("income")) || [];
  const id = "sq_" + p.id;
  if (income.some((i) => i.id === id)) return false;

  const gross = (p.amount_money?.amount || 0) / 100;      // what she charged
  const tip = (p.tip_money?.amount || 0) / 100;
  const fees = (p.processing_fee || []).reduce((s, f) => s + (f.amount_money?.amount || 0), 0) / 100;
  if (!gross && !tip) return false;

  const { date } = localParts(p.created_at);
  const detail = await orderDetail(p.order_id);
  const note = p.note || "";
  const biz = detail.biz || (/(glow|tan|airbrush)/i.test(note) ? "VG" : "PP");
  const label = detail.name || note || "Square payment";

  income.unshift({
    id, square: true, date,
    amount: gross + tip,
    tip: tip || 0,
    fees: fees || 0,
    net: Math.round((gross + tip - fees) * 100) / 100,
    biz,
    service: detail.name || "",
    source: "Square",
    note: label,
  });
  await sbPut("income", income);
  return true;
}

/* ---------- which location? ---------- */
async function resolveLocation() {
  const given = (process.env.SQUARE_LOCATION_ID || "").trim();
  let list = [];
  try {
    const r = await fetch(`${SQ}/locations`, { headers: sqHeaders() });
    const j = await r.json();
    list = j.locations || [];
    if (j.errors) return { id: "", source: "error", errors: j.errors };
  } catch (e) {
    return { id: "", source: "error", detail: String(e) };
  }

  /* Only use the env value if this account actually has that location.
     A stale or mistyped id makes Square reject the whole query. */
  if (given && list.some((l) => l.id === given)) return { id: given, source: "env", list: list.map((l) => l.id) };

  const active = list.find((l) => l.status === "ACTIVE") || list[0];
  return {
    id: active ? active.id : "",
    source: given ? "env-was-wrong" : "auto",
    name: active ? active.name : "",
    ignored: given || undefined,
    list: list.map((l) => ({ id: l.id, name: l.name, status: l.status })),
  };
}

/* ---------- signature check ---------- */
function verified(req, rawBody) {
  const key = process.env.SQUARE_WEBHOOK_KEY;
  if (!key) return true;                       // not configured yet — allow, but log
  const sig = req.headers["x-square-hmacsha256-signature"];
  if (!sig) return false;
  const url = `https://${req.headers.host}${req.url}`;
  const hmac = crypto.createHmac("sha256", key).update(url + rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(String(sig)));
  } catch { return false; }
}

export const config = { api: { bodyParser: false } };

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/* ============================ handler ============================ */
export default async function handler(req, res) {
  if (!process.env.SQUARE_ACCESS_TOKEN || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Square sync isn't configured yet — add the environment variables in Vercel." });
  }

  /* ---- diagnostic: which parameter is Square unhappy with? ---- */
  if (req.method === "GET" && req.query.probe) {
    const loc = await resolveLocation();
    const now = new Date();
    const tries = [
      ["bare", `${SQ}/bookings?limit=100`],
      ["with location", `${SQ}/bookings?limit=100&location_id=${encodeURIComponent(loc.id)}`],
      ["with start_at_min (now)", `${SQ}/bookings?limit=100&location_id=${encodeURIComponent(loc.id)}&start_at_min=${rfc(now)}`],
      ["with a past start_at_min", `${SQ}/bookings?limit=100&location_id=${encodeURIComponent(loc.id)}&start_at_min=${rfc(new Date(Date.now() - 45 * 86400000))}`],
      ["with both ends", `${SQ}/bookings?limit=100&location_id=${encodeURIComponent(loc.id)}&start_at_min=${rfc(now)}&start_at_max=${rfc(new Date(Date.now() + 180 * 86400000))}`],
    ];
    const out = [];
    for (const [label, url] of tries) {
      try {
        const r = await fetch(url, { headers: sqHeaders() });
        const j = await r.json();
        out.push({ label, status: r.status, bookings: (j.bookings || []).length, errors: j.errors || null });
      } catch (e) { out.push({ label, crashed: String(e) }); }
    }
    return res.status(200).json({ location: loc.id, locationSource: loc.source, tries: out });
  }

  /* ---- her customer list, for the one-off import ---- */
  if (req.method === "GET" && req.query.customers) {
    try {
      const out = [];
      let cursor = "";
      /* Square pages at 100; walk it so a full book comes back in one go */
      for (let page = 0; page < 20; page++) {
        const url = `${SQ}/customers?limit=100&sort_field=CREATED_AT&sort_order=DESC` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        const r = await fetch(url, { headers: sqHeaders() });
        const j = await r.json();
        if (j.errors) return res.status(400).json({ error: j.errors[0]?.detail || "Square rejected the request", code: j.errors[0]?.code });
        for (const c of j.customers || []) {
          const name = [c.given_name, c.family_name].filter(Boolean).join(" ").trim() || c.company_name || "";
          const phone = String(c.phone_number || "").replace(/\D/g, "").slice(-10);
          if (!name && !phone) continue;
          out.push({ name, phone, email: c.email_address || "", note: c.note || "", created: (c.created_at || "").slice(0, 10) });
        }
        cursor = j.cursor || "";
        if (!cursor) break;
      }
      return res.status(200).json({ ok: true, count: out.length, customers: out });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Could not read your customers", detail: String(e) });
    }
  }

  /* ---- on-demand pull: the Sync Square button ---- */
  if (req.method === "GET") {
    try {
      const loc = await resolveLocation();

      /* Normally: a bit of history and a season ahead.
         ?all=1 : everything Square has, a year either side, for a first import. */
      const everything = !!req.query.all;
      const backDays = everything ? 365 : 45;
      const fwdDays = everything ? 365 : 180;
      const start = new Date(Date.now() - backDays * 86400000);
      const end = new Date(Date.now() + fwdDays * 86400000);

      /* Square only allows 31 days per query, so walk the range in chunks
         and page through each one. */
      const bookings = [];
      const seen = new Set();
      const WINDOW = 30 * 86400000;
      let windowStart = start.getTime();
      let windows = 0;
      const maxWindows = everything ? 26 : 9;

      while (windowStart < end.getTime() && windows < maxWindows) {
        const windowEnd = Math.min(windowStart + WINDOW, end.getTime());
        let cursor = "";

        for (let page = 0; page < 10; page++) {
          const url = `${SQ}/bookings?limit=100` +
            (loc.id ? `&location_id=${encodeURIComponent(loc.id)}` : "") +
            `&start_at_min=${rfc(new Date(windowStart))}&start_at_max=${rfc(new Date(windowEnd))}` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
          const r = await fetch(url, { headers: sqHeaders() });
          const j = await r.json();

          if (j.errors) {
            return res.status(400).json({
              error: j.errors[0]?.detail || "Square rejected the request",
              code: j.errors[0]?.code || null,
              field: j.errors[0]?.field || null,
              allErrors: j.errors,
              triedUrl: url,
              hint: /PERMISSION|FORBIDDEN|UNAUTHORIZED/i.test(j.errors[0]?.code || "")
                ? "The token is missing a permission — it needs APPOINTMENTS_READ, CUSTOMERS_READ, ITEMS_READ and PAYMENTS_READ."
                : null,
              location: loc.id,
            });
          }

          for (const b of j.bookings || []) {
            if (!seen.has(b.id)) { seen.add(b.id); bookings.push(b); }
          }
          cursor = j.cursor || "";
          if (!cursor) break;
        }

        windowStart = windowEnd;
        windows++;
      }

      const found = bookings.length;
      const evts = [];
      for (const b of bookings) evts.push(await toEvent(b));
      const result = await upsertEvents(evts);

      let paid = 0, payErr = null;
      try {
        const since = rfc(new Date(Date.now() - (everything ? 365 : 30) * 86400000));
        let pcur = "";
        for (let page = 0; page < (everything ? 20 : 2); page++) {
          const pr = await fetch(`${SQ}/payments?begin_time=${since}&limit=100&sort_order=DESC` +
            (pcur ? `&cursor=${encodeURIComponent(pcur)}` : ""), { headers: sqHeaders() });
          const pj = await pr.json();
          if (pj.errors) { payErr = pj.errors[0]?.detail || null; break; }
          for (const p of pj.payments || []) { if (await recordPayment(p)) paid++; }
          pcur = pj.cursor || "";
          if (!pcur) break;
        }
      } catch (e) { payErr = String(e); }

      return res.status(200).json({
        ok: true,
        location: loc.id || "(all locations)",
        locationSource: loc.source,
        locationNote: loc.source === "env-was-wrong"
          ? `SQUARE_LOCATION_ID in Vercel (${loc.ignored}) is not a location on this account — ignored. Remove it, or set it to ${loc.id}.`
          : undefined,
        found,
        paid,
        payErr,
        ...result,
        window: `${backDays} days back, ${fwdDays} forward, in ${windows} chunks`,
        note: found === 0
          ? "Square returned no bookings in the next 60 days for this location. If you just made a test booking, check it's on this same location and in the future."
          : undefined,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Sync failed", detail: String(e) });
    }
  }

  /* ---- webhooks ---- */
  if (req.method === "POST") {
    let raw = "";
    if (typeof req.body === "string") raw = req.body;
    else if (req.body && Object.keys(req.body).length) raw = JSON.stringify(req.body);
    else raw = await readRaw(req);
    if (!verified(req, raw)) return res.status(401).json({ error: "bad signature" });

    let body;
    try { body = JSON.parse(raw); } catch { return res.status(400).json({ error: "bad body" }); }

    const type = body.type || "";
    try {
      if (type.startsWith("booking.")) {
        const b = body.data?.object?.booking;
        if (b) await upsertEvents([await toEvent(b)]);
      } else if (type.startsWith("payment.")) {
        await recordPayment(body.data?.object?.payment);
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(200).json({ ok: false });   // 200 so Square doesn't retry forever
    }
  }

  return res.status(405).json({ error: "Use GET or POST" });
}
