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
  let s = String(txt).replace(/[^\d.,]/g, "").trim();
  if (!s) return null;
  if (s.indexOf(",") >= 0 && s.indexOf(".") >= 0)
    s = s.replace(/\./g, "").replace(",", ".");
  else if (s.indexOf(",") >= 0) s = s.replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
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
  m = html.match(/[£$€]\s*([\d.,]+)/);
  if (m) return parsePrice(m[1]);
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
  await fetch(
    `https://api.telegram.org/bot${env.TG_BOT}/sendMessage?chat_id=${env.TG_CHAT}` +
      `&parse_mode=Markdown&text=${encodeURIComponent(msg)}`,
  );
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
    return { skipped: true, interval, elapsed: Math.round((now - last) / 60000) };
  }

  let alerts = 0;
  for (const p of products) {
    p.last_checked = now.toISOString();
    const price = await fetchPrice(p.url);
    p.last_price = price;
    if (price != null && price <= p.target_price) {
      alerts++;
      await tgSend(
        env,
        `💰 *Prezzo basso!*\n${p.url}\nPrezzo: €${price} (soglia €${p.target_price})`,
      );
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

  return { checked: products.length, alerts };
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
      if (key !== env.SECRET)
        return new Response("forbidden", { status: 403 });
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
