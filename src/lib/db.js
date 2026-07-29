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
   Which table a saved name belongs in.
   PUBLIC  = clients can read it (prices, hours, notices, pageants)
   PRIVATE = Paige only (everything else)
------------------------------------------------------------------- */
const PUBLIC_KEYS = new Set(["biz-settings", "alerts", "pageants"]);
const isImage = (k) => k.startsWith("receipt-img:");

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
    if (isImage(k)) {
      const id = k.slice("receipt-img:".length);
      const { data } = await supabase.from("receipt_images").select("data").eq("id", id).maybeSingle();
      return data ? data.data : null;
    }

    if (k === "leads") {
      if (!signedIn) return [];
      const { data } = await supabase.from("leads").select("*").order("created_at", { ascending: false });
      return (data || []).map((r) => ({
        id: r.id,
        name: r.name,
        address: r.address,
        contact: r.contact,
        timeframe: r.timeframe,
        note: r.note,
        date: (r.created_at || "").slice(0, 10),
      }));
    }

    const table = PUBLIC_KEYS.has(k) ? "public_data" : "private_data";
    if (table === "private_data" && !signedIn) return null;
    const { data } = await supabase.from(table).select("value").eq("key", k).maybeSingle();
    return data ? data.value : null;
  } catch (e) {
    console.error("load failed:", k, e);
    return null;
  }
}

/* ---------------------------- WRITE ------------------------------- */
export async function saveJSON(k, v) {
  try {
    if (isImage(k)) {
      const id = k.slice("receipt-img:".length);
      const { error } = await supabase.from("receipt_images").upsert({ id, data: v });
      if (error) throw error;
      return true;
    }

    if (k === "leads") {
      const list = Array.isArray(v) ? v : [];
      if (!signedIn) {
        // A client just submitted a valuation request: insert only the new one.
        const fresh = list[0];
        if (!fresh) return true;
        const { error } = await supabase.from("leads").insert({
          name: fresh.name || "",
          address: fresh.address || "",
          contact: fresh.contact || "",
          timeframe: fresh.timeframe || "",
          note: fresh.note || "",
        });
        if (error) throw error;
        return true;
      }
      // Paige saving the list means she removed one or more.
      const keep = new Set(list.map((l) => l.id));
      const { data: existing } = await supabase.from("leads").select("id");
      const gone = (existing || []).map((r) => r.id).filter((id) => !keep.has(id));
      if (gone.length) await supabase.from("leads").delete().in("id", gone);
      return true;
    }

    const table = PUBLIC_KEYS.has(k) ? "public_data" : "private_data";
    const { error } = await supabase.from(table).upsert({ key: k, value: v });
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
    if (isImage(k)) {
      const id = k.slice("receipt-img:".length);
      await supabase.from("receipt_images").delete().eq("id", id);
      return true;
    }
    const table = PUBLIC_KEYS.has(k) ? "public_data" : "private_data";
    await supabase.from(table).delete().eq("key", k);
    return true;
  } catch (e) {
    console.error("delete failed:", k, e);
    return false;
  }
}

/* ------------------- LIVE UPDATES ACROSS DEVICES ------------------ */
export function onRemoteChange(cb) {
  let timer = null;
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(cb, 400); // small delay so a burst of saves counts once
  };
  const channel = supabase
    .channel("paige-hq-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "public_data" }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "private_data" }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, bump)
    .subscribe();
  return () => {
    clearTimeout(timer);
    supabase.removeChannel(channel);
  };
}
