/* ============================================================
   POCKET AI  —  server side only

   Built against the published API (docs.heypocketai.com/docs/api):
     base    https://public.heypocketai.com/api/v1
     auth    Authorization: Bearer pk_xxx
     list    GET  /public/recordings
     detail  GET  /public/recordings/:id

   The key never reaches Paige's phone. Every response below reports
   what Pocket actually said — if a call fails, it says so plainly
   rather than returning something that looks like success.

   Vercel env var:  POCKET_API_KEY = pk_...
   ============================================================ */

const BASE = process.env.POCKET_BASE || "https://public.heypocketai.com/api/v1";
const KEY = (process.env.POCKET_API_KEY || "").trim();

const headers = () => ({
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
});

/* Pocket sometimes answers with an empty errors array — only a non-empty
   one is a real failure. (Same trap Square set.) */
const failed = (j) => (Array.isArray(j && j.errors) ? j.errors.length > 0 : !!(j && j.error));

async function call(path, init) {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: headers() });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  return { status: r.status, ok: r.ok && !failed(j), body: j };
}

/* A recording, reduced to what the Log Visit sheet needs. Nothing is
   invented — a field Pocket did not send comes back empty. */
const tidy = (r = {}) => ({
  id: r.id || r.recording_id || "",
  title: r.title || r.name || "Untitled recording",
  at: r.created_at || r.recorded_at || r.createdAt || "",
  seconds: Number(r.duration || r.duration_seconds || 0) || 0,
  status: r.status || r.processing_status || "",
  tags: Array.isArray(r.tags) ? r.tags : [],
});

export default async function handler(req, res) {
  if (!KEY) {
    return res.status(200).json({
      connected: false,
      reason: "no-key",
      message: "Pocket isn't connected yet. Add POCKET_API_KEY in Vercel, then redeploy.",
    });
  }

  try {
    /* ---- is the key good? ---- */
    if (req.query.status) {
      const r = await call("/public/recordings?limit=1");
      if (!r.ok) {
        return res.status(200).json({
          connected: false,
          reason: r.status === 401 || r.status === 403 ? "bad-key" : "error",
          status: r.status,
          message: r.status === 401 || r.status === 403
            ? "Pocket refused that API key. Make a new one and update POCKET_API_KEY."
            : "Pocket answered, but not with recordings. See raw below.",
          raw: r.body,
        });
      }
      const list = r.body?.recordings || r.body?.data || [];
      return res.status(200).json({
        connected: true,
        message: "Pocket is connected.",
        sample: list.length ? tidy(list[0]) : null,
      });
    }

    /* ---- one recording, with its summary and transcript ---- */
    if (req.query.id) {
      const r = await call(`/public/recordings/${encodeURIComponent(req.query.id)}`);
      if (!r.ok) {
        return res.status(r.status || 400).json({
          error: "Pocket could not return that recording",
          status: r.status,
          raw: r.body,
        });
      }
      const rec = r.body?.recording || r.body || {};
      const summary = rec.summary || rec.summarization || rec.summaries || null;
      return res.status(200).json({
        ok: true,
        recording: tidy(rec),
        summary: typeof summary === "string" ? summary : (summary?.markdown || summary?.text || ""),
        actionItems: Array.isArray(rec.action_items) ? rec.action_items : [],
        transcript: rec.transcript || "",
        ready: !/process|pending|queue/i.test(String(rec.status || "")),
      });
    }

    /* ---- recent recordings, for her to pick from ---- */
    const limit = Math.min(Number(req.query.limit) || 25, 50);
    const qs = new URLSearchParams({ limit: String(limit) });
    if (req.query.startDate) qs.set("startDate", req.query.startDate);
    if (req.query.endDate) qs.set("endDate", req.query.endDate);

    const r = await call(`/public/recordings?${qs.toString()}`);
    if (!r.ok) {
      return res.status(r.status || 400).json({
        error: "Pocket could not list your recordings",
        status: r.status,
        raw: r.body,
      });
    }
    const list = (r.body?.recordings || r.body?.data || []).map(tidy);
    return res.status(200).json({ ok: true, count: list.length, recordings: list });
  } catch (e) {
    return res.status(500).json({ error: "Could not reach Pocket", detail: String(e) });
  }
}
