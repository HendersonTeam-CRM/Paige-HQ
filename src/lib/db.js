import { createClient } from "@supabase/supabase-js";

/* ------------------------------------------------------------------
   Connection — values come from Vercel's Environment Variables
   (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY)
------------------------------------------------------------------- */
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/* ------------------------------------------------------------------
   Where each saved name lives.

   PUBLIC   → clients can read it: prices, hours, notices, pageants,
              the gallery index and its photos.
   REVIEWS  → its own table, so a client with no account can leave one.
   PRIVATE  → Paige only: clients, calendar, income, mileage, to-dos,
              settings, receipts.
------------------------------------------------------------------- */
const PUBLIC_KEYS = new Set(["biz-settings", "alerts", "pageants", "gallery"]);
const isGalleryImg = (k) => k.startsWith("gallery-img:");
const isReceiptImg = (k) => k.startsWith("receipt-img:");

let signedIn = false;
supabase.auth.getSession().then(({ data }) => { signedIn = !!data.session; });
supabase.auth.onAuthStateChange((_e, session) => { signedIn = !!session; });

/* ---------------------------- AUTH -------------------------------- */
export const auth = {
  async currentSession() {
    const { data } = await supabase.auth.getSession();
    signedIn = !!data.session;
    return data.session;
  },
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    signedIn = true;
    return data.session;
  },
  async signOut() {
    await supabase.auth.signOut();
    signedIn = false;
  },
};

/* ---------------------------- READ -------------------------------- */
export async function loadJSON(k) {
  try {
    if (isReceiptImg(k)) {
      const id = k.slice("receipt-img:".length);
      const { data } = await supabase.from("receipt_images").select("data").eq("id", id).maybeSingle();
      return data ? data.data : null;
    }

    if (isGalleryImg(k) || PUBLIC_KEYS.has(k)) {
      const { data } = await supabase.from("public_data").select("value").eq("key", k).maybeSingle();
      return data ? data.value : null;
    }

    if (k === "reviews") {
      const { data } = await supabase.from("reviews").select("*").order("created_at", { ascending: false });
      return (data || []).map((r) => ({
        id: r.id,
        brand: r.brand,
        name: r.name,
        rating: r.rating,
        text: r.text,
        approved: r.approved,
        date: (r.created_at || "").slice(0, 10),
      }));
    }

    if (k === "leads") {
      if (!signedIn) return [];
      const { data } = await supabase.from("leads").select("*").order("created_at", { ascending: false });
      return (data || []).map((r) => ({
        id: r.id, name: r.name, address: r.address, contact: r.contact,
        timeframe: r.timeframe, note: r.note, date: (r.created_at || "").slice(0, 10),
      }));
    }

    if (!signedIn) return null;                       /* everything else is hers */
    const { data } = await supabase.from("private_data").select("value").eq("key", k).maybeSingle();
    return data ? data.value : null;
  } catch (e) {
    console.error("load failed:", k, e);
    return null;
  }
}

/* ---------------------------- WRITE ------------------------------- */
export async function saveJSON(k, v) {
  try {
    if (isReceiptImg(k)) {
      const id = k.slice("receipt-img:".length);
      const { error } = await supabase.from("receipt_images").upsert({ id, data: v });
      if (error) throw error;
      return true;
    }

    if (isGalleryImg(k) || PUBLIC_KEYS.has(k)) {
      const { error } = await supabase.from("public_data").upsert({ key: k, value: v });
      if (error) throw error;
      return true;
    }

    if (k === "reviews") {
      const list = Array.isArray(v) ? v : [];
      if (!signedIn) {
        /* A client just left a review — insert it, unapproved. */
        const fresh = list.find((r) => r.approved === false && String(r.id).startsWith("rv"));
        if (!fresh) return true;
        const { error } = await supabase.from("reviews").insert({
          brand: fresh.brand, name: fresh.name, rating: fresh.rating, text: fresh.text, approved: false,
        });
        if (error) throw error;
        return true;
      }
      /* Paige publishing, hiding or deleting. */
      const { data: existing } = await supabase.from("reviews").select("id");
      const keep = new Set(list.map((r) => String(r.id)));
      const gone = (existing || []).map((r) => r.id).filter((id) => !keep.has(String(id)));
      if (gone.length) await supabase.from("reviews").delete().in("id", gone);
      for (const r of list) {
        if (String(r.id).startsWith("rv")) {
          await supabase.from("reviews").insert({ brand: r.brand, name: r.name, rating: r.rating, text: r.text, approved: r.approved !== false });
        } else {
          await supabase.from("reviews").update({ approved: r.approved !== false, text: r.text, rating: r.rating }).eq("id", r.id);
        }
      }
      return true;
    }

    if (k === "leads") {
      const list = Array.isArray(v) ? v : [];
      if (!signedIn) {
        const fresh = list[0];
        if (!fresh) return true;
        const { error } = await supabase.from("leads").insert({
          name: fresh.name || "", address: fresh.address || "", contact: fresh.contact || "",
          timeframe: fresh.timeframe || "", note: fresh.note || "",
        });
        if (error) throw error;
        return true;
      }
      const { data: existing } = await supabase.from("leads").select("id");
      const keep = new Set(list.map((l) => l.id));
      const gone = (existing || []).map((r) => r.id).filter((id) => !keep.has(id));
      if (gone.length) await supabase.from("leads").delete().in("id", gone);
      return true;
    }

    const { error } = await supabase.from("private_data").upsert({ key: k, value: v });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error("save failed:", k, e);
    return false;
  }
}

/* --------------------------- DELETE ------------------------------- */
export async function removeKey(k) {
  try {
    if (isReceiptImg(k)) {
      await supabase.from("receipt_images").delete().eq("id", k.slice("receipt-img:".length));
      return true;
    }
    if (isGalleryImg(k) || PUBLIC_KEYS.has(k)) {
      await supabase.from("public_data").delete().eq("key", k);
      return true;
    }
    await supabase.from("private_data").delete().eq("key", k);
    return true;
  } catch (e) {
    console.error("delete failed:", k, e);
    return false;
  }
}


/* ------------------- CLIENT PORTAL LOOKUP -------------------
   Hands a phone number to the client_lookup function in Supabase,
   which returns only that one client and their own appointments.  */
export async function findClientByPhone(phone) {
  try {
    const { data, error } = await supabase.rpc("client_lookup", { p_phone: phone });
    if (error) throw error;
    return data || null;
  } catch (e) {
    console.error("client lookup failed:", e);
    return null;
  }
}



/* ------------------- WAIVER SIGNATURE -------------------
   A client isn't signed in, so this goes through a narrow
   database function that can only stamp their own record.   */
export async function signWaiver(phone, waiver) {
  try {
    const { error } = await supabase.rpc("client_sign_waiver", { p_phone: phone, p_waiver: waiver });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error("waiver failed:", e);
    return false;
  }
}

/* ------------------- CLIENT REQUESTS -------------------
   A client asking for a waitlist spot, a reschedule, or a
   question. Anyone may send one; only Paige can read them.   */
export async function sendRequest(req) {
  try {
    const { error } = await supabase.from("client_requests").insert({
      name: req.name || "", phone: req.phone || "", brand: req.brand || "",
      kind: req.kind || "question", note: req.note || "", handled: false,
    });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error("request failed:", e);
    return false;
  }
}

export async function loadRequests() {
  try {
    const { data } = await supabase.from("client_requests").select("*")
      .eq("handled", false).order("created_at", { ascending: false });
    return (data || []).map((r) => ({
      id: r.id, name: r.name, phone: r.phone, brand: r.brand,
      kind: r.kind, note: r.note, date: (r.created_at || "").slice(0, 10),
    }));
  } catch (e) {
    console.error("requests load failed:", e);
    return [];
  }
}

export async function clearRequest(id) {
  try { await supabase.from("client_requests").update({ handled: true }).eq("id", id); return true; }
  catch (e) { console.error(e); return false; }
}

/* ------------------- LIVE UPDATES ACROSS DEVICES ------------------ */
export function onRemoteChange(cb) {
  let timer = null;
  const bump = () => { clearTimeout(timer); timer = setTimeout(cb, 400); };
  const channel = supabase
    .channel("paige-hq-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "public_data" }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "private_data" }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "reviews" }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "client_requests" }, bump)
    .subscribe();
  return () => { clearTimeout(timer); supabase.removeChannel(channel); };
}
