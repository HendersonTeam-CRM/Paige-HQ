/* ============================================================
   PAIGE HQ → HER PHONE
   Publishes everything in the app as a calendar feed her iPhone
   (or Google Calendar) can subscribe to. It refreshes on its own,
   so Square bookings, dance lessons and pageants all appear on her
   phone without her doing anything.

   GET /api/calendar?t=SECRET

   The token comes from Settings → Calendar Sync, so the feed URL
   is unguessable. Regenerating it in Settings kills the old link.

   Vercel env vars (same ones the Square function uses):
     SUPABASE_URL
     SUPABASE_SERVICE_ROLE_KEY
   ============================================================ */

const EVENT_LABEL = {
  tan: "Glow",
  lesson: "Lesson",
  dance: "Dance",
  pageant: "Pageant",
  showing: "Showing",
  emcee: "Emcee",
  client: "Appointment",
};

async function sbGet(key) {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/private_data?key=eq.${encodeURIComponent(key)}&select=value`,
    { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0].value : null;
}

async function sbGetPublic(key) {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/public_data?key=eq.${encodeURIComponent(key)}&select=value`,
    { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0].value : null;
}

/* ICS wants YYYYMMDDTHHMMSS with no punctuation */
const stamp = (date, time) => `${String(date).replace(/-/g, "")}T${String(time || "09:00").replace(":", "")}00`;
const addMinutes = (date, time, mins) => {
  const [h, m] = String(time || "09:00").split(":").map(Number);
  const d = new Date(`${date}T00:00:00`);
  d.setHours(h, m + (mins || 30), 0, 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
};
const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/* ICS lines must wrap at 75 octets */
function fold(line) {
  if (line.length <= 74) return line;
  const out = [line.slice(0, 74)];
  let rest = line.slice(74);
  while (rest.length > 73) { out.push(" " + rest.slice(0, 73)); rest = rest.slice(73); }
  if (rest) out.push(" " + rest);
  return out.join("\r\n");
}

export default async function handler(req, res) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).send("Calendar feed isn't configured yet.");
  }

  const token = (req.query.t || "").toString();
  const settings = (await sbGet("settings")) || {};
  if (!settings.calToken || token !== settings.calToken) {
    return res.status(403).send("Not a valid calendar link.");
  }

  const events = (await sbGet("events")) || [];
  const pageants = (await sbGetPublic("pageants")) || [];

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Paige HQ//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Paige HQ",
    "X-WR-TIMEZONE:America/New_York",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
  ];

  const push = (uid, date, time, dur, title, desc, allDay) => {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}@paigehq`);
    lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`);
    if (allDay) {
      lines.push(`DTSTART;VALUE=DATE:${String(date).replace(/-/g, "")}`);
    } else {
      lines.push(`DTSTART;TZID=America/New_York:${stamp(date, time)}`);
      lines.push(`DTEND;TZID=America/New_York:${addMinutes(date, time, dur)}`);
    }
    lines.push(fold(`SUMMARY:${esc(title)}`));
    if (desc) lines.push(fold(`DESCRIPTION:${esc(desc)}`));
    lines.push("END:VEVENT");
  };

  for (const e of events) {
    if (!e.date) continue;
    const mark = EVENT_LABEL[e.type] || "Appointment";
    const title = e.clientName ? `${mark} · ${e.clientName}` : `${mark} · ${e.title || ""}`;
    push(e.id, e.date, e.time, e.durMin, title.trim(), [e.title, e.notes].filter(Boolean).join(" — "), !e.time);
  }

  for (const p of pageants) {
    if (!p.date) continue;
    const girls = (p.girls || []).map((g) => g.name).filter(Boolean).join(", ");
    push("pg" + p.id, p.date, "", 0, `Pageant · ${p.name}`, [p.location, girls].filter(Boolean).join(" — "), true);
  }

  lines.push("END:VCALENDAR");

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Content-Disposition", 'inline; filename="paige-hq.ics"');
  return res.status(200).send(lines.join("\r\n"));
}
