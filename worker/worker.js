// Cloudflare Worker — Monitoraggio prezzi Amazon (modulo)
//
// Variabili da impostare nella dashboard Cloudflare
// (Settings > Variables, le secret marcate come "Encrypt"):
//   OWNER     owner GitHub (es. Fr4m3)
//   REPO      nome repo (es. AnalisiPrezzo)
//   GH_TOKEN  PAT GitHub (repo + workflow)
//   TG_BOT    token bot Telegram
//   TG_CHAT   chat id Telegram
//   SECRET    stringa segreta condivisa con la pagina web
//
// Trigger:
//   - Cron (impostato su dashboard o wrangler.toml): check schedulato
//   - GET /?force=1&key=SECRET : check immediato (bottone "Check ora")

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

function safeParse(txt, fallback) {
  try {
    return JSON.parse(txt);
  } catch (e) {
    return fallback;
  }
}

function parsePrice(txt) {
  if (!txt) return null;
  let s = String(txt)
    .replace(/[^\d.,]/g, "")
    .trim();
  if (!s) return null;
  if (s.indexOf(",") >= 0 && s.indexOf(".") >= 0)
    s = s.replace(/\./g, "").replace(",", ".");
  else if (s.indexOf(",") >= 0) s = s.replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Filtra i prezzi non realistici (causa degli alert fasulli).
// - scarta <=0 o > 1.000.000 (assurdo)
// - se esiste una soglia, richiede che il prezzo stia in una banda
//   [soglia*0.4 , max(soglia*12, 5000)]: cosi' un prezzo reale (anche molto
//   sotto soglia, perche' e' proprio cio' che vogliamo rilevare) passa,
//   mentre un valore spazzatura (es. 60 o 600.000 su un oggetto da 600) viene scartato.
// - se c'e' una lettura precedente, un balzo >50% viene scartato SOLO se anche
//   fuori banda; se dentro banda viene accettato (corregge un'eventuale baseline errata).
function validatePrice(price, prev, target) {
  if (price == null || !isFinite(price) || price <= 0) return false;
  if (price > 1000000) return false;
  const lower = target != null && target > 0 ? target * 0.4 : 1;
  const upper = target != null && target > 0 ? Math.max(target * 12, 5000) : 1000000;
  const inBand = price >= lower && price <= upper;
  if (prev != null && prev > 0) {
    const dev = Math.abs(price - prev) / prev;
    if (dev > 0.5 && !inBand) return false;
  } else if (!inBand) {
    return false; // prima rilevazione fuori banda -> non registriamo il valore errato
  }
  return true;
}

async function fetchPrice(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9," +
      "image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
  };
  const r = await fetch(url, { headers, redirect: "follow" });
  const html = await r.text();
  const low = html.toLowerCase();
  if (
    low.includes("robot check") ||
    low.includes("captcha") ||
    low.includes("api-services-support")
  ) {
    console.error("Amazon robot-check per " + url);
    return null;
  }
  let m = html.match(/"priceAmount"\s*:\s*([\d.]+)/);
  if (m) return parsePrice(m[1]);
  m = html.match(/id="priceblock_(?:ourprice|dealprice)"[^>]*>([^<]+)</i);
  if (m) return parsePrice(m[1]);
  m = html.match(/a-price-whole[^>]*>([\d.,\s]+?)</);
  if (m) {
    const dec = html.match(/a-price-decimal[^>]*>([\d.,\s]+?)</);
    return parsePrice(m[1] + (dec ? dec[1] : ""));
  }
  m = html.match(/class="a-offscreen"[^>]*>([^<]+)</);
  if (m) {
    const v = parsePrice(m[1]);
    if (v) return v;
  }
  // NOTA: volutamente NON usiamo un catch-all tipo /[£$€]\s*([\d.,]+)/
  // perche' matcha importi casuali nella pagina (es. "risparmia X") e genera
  // prezzi non realistici. Ci affidiamo ai selettori strutturati sopra.
  console.error("Nessun prezzo trovato per " + url);
  return null;
}

async function ghGet(env, path) {
  const r = await fetch(
    `https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "cf-worker",
      },
    },
  );
  if (!r.ok) throw new Error("ghGet " + path + ": " + r.status);
  return r.json();
}

async function ghPut(env, path, content, sha, message) {
  const r = await fetch(
    `https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "cf-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, content, sha, branch: "main" }),
    },
  );
  return r;
}

async function tgSend(env, msg) {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${env.TG_BOT}/sendMessage?chat_id=${env.TG_CHAT}` +
        `&text=${encodeURIComponent(msg)}`,
    );
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: !!j.ok, description: j.description };
  } catch (e) {
    return { status: 0, ok: false, error: String(e) };
  }
}

async function runCheck(env, force) {
  const pf = await ghGet(env, "products.json");
  const cf = await ghGet(env, "config.json");
  const products = safeParse(b64decode(pf.content), []);
  const config = safeParse(b64decode(cf.content), { interval_minutes: 60 });
  const now = new Date();
  const interval = config.interval_minutes || 60;
  const last = config.last_run ? new Date(config.last_run) : null;
  if (!force && last && (now - last) / 60000 < interval) {
    return {
      skipped: true,
      interval,
      elapsed: Math.round((now - last) / 60000),
    };
  }

  let alerts = 0;
  const tgResults = [];
  for (const p of products) {
    const prev = p.last_price == null ? null : p.last_price;
    if (p.initial_price == null && prev != null) p.initial_price = prev;
    p.last_checked = now.toISOString();
    const price = await fetchPrice(p.url);
    // Filtro prezzi non realistici: NON aggiorniamo last_price e NON inviamo alert
    if (!validatePrice(price, prev, p.target_price)) {
      console.warn(
        `Prezzo non valido/non realistico per ${p.url}: ${price} (prev ${prev}) — skip`,
      );
      continue;
    }
    p.last_price = price;
    if (p.initial_price == null) p.initial_price = price;
    const changed = prev != null && Math.abs(price - prev) >= 0.01;
    const below = price <= p.target_price;
    const crossedBelow = prev == null || prev > p.target_price;
    const label = p.name || p.url;
    let msg = null;
    if (below && (crossedBelow || changed)) {
      // AVVISO SOTTO SOGLIA — messaggio dedicato e diverso
      msg = `🎯 PREZZO SOTTO SOGLIA!\n${label}\n€${price}  (soglia €${p.target_price})`;
      if (changed && prev != null) msg += `\n(variazione €${prev} → €${price})`;
    } else if (changed && prev != null) {
      // AVVISO VARIAZIONE — ogni cambiamento reale, anche sopra soglia
      const arrow = price < prev ? "📉" : "📈";
      msg = `${arrow} PREZZO AGGIORNATO\n${label}\n€${prev} → €${price}`;
      if (p.initial_price != null) {
        const d = (price - p.initial_price).toFixed(2);
        msg += `\n(dal primo rilevamento €${p.initial_price}, delta €${d})`;
      }
    }
    if (msg) {
      alerts++;
      const tg = await tgSend(env, msg);
      tgResults.push({ url: p.url, tg });
    }
  }

  await ghPut(
    env,
    "products.json",
    b64encode(JSON.stringify(products, null, 2)),
    pf.sha,
    "chore: update prices (worker)",
  );
  config.last_run = now.toISOString();
  await ghPut(
    env,
    "config.json",
    b64encode(JSON.stringify(config, null, 2)),
    cf.sha,
    "chore: update config (worker)",
  );

  return { checked: products.length, alerts, tg: tgResults };
}

export default {
  async scheduled(_event, env) {
    try {
      return await runCheck(env, false);
    } catch (e) {
      console.error("scheduled error", e);
      return { error: String(e) };
    }
  },
  async fetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch (e) {
      return new Response("bad request", { status: 400 });
    }
    const force = url.searchParams.get("force");
    const key = url.searchParams.get("key");
    if (force === "1") {
      if (key !== env.SECRET) return new Response("forbidden", { status: 403 });
      try {
        const res = await runCheck(env, true);
        return new Response(JSON.stringify(res), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("AnalisiPrezzo worker", { status: 200 });
  },
};
