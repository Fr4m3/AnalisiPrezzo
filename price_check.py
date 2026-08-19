#!/usr/bin/env python3
"""Price-check script run by GitHub Actions.
Reads products.json, fetches each Amazon price, sends a Telegram alert
when the price is at or below the target, then writes back the last
checked price/time and commits the change.

Honours config.json:
    interval_minutes  - minimum minutes between two real checks
    last_run          - ISO timestamp of the previous real check
Set FORCE_CHECK=true to ignore the interval (used by the "Check ora" button).

Env vars (set as GitHub Secrets):
    TELEGRAM_BOT   - bot token from @BotFather
    TELEGRAM_CHAT  - your chat id
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

import requests

DATA_FILE = "products.json"
CONFIG_FILE = "config.json"
TELEGRAM_BOT = os.getenv("TELEGRAM_BOT")
TELEGRAM_CHAT = os.getenv("TELEGRAM_CHAT")
FORCE = str(os.getenv("FORCE_CHECK", "")).lower() in ("1", "true", "yes")

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

# Pattern that catches the dedicated price spans first, then any currency amount.
PRICE_RE = re.compile(
    r'id="priceblock_(?:ourprice|dealprice)"[^>]*>([^<]+)<',
    re.IGNORECASE,
)
AMOUNT_RE = re.compile(r"[£$€]\s*([\d.,]+)")


def _to_float(txt: str):
    try:
        return float(
            txt.replace("$", "")
            .replace("£", "")
            .replace("€", "")
            .replace(",", "")
            .replace(" ", "")
            .strip()
        )
    except (ValueError, AttributeError):
        return None


def fetch_price(url: str):
    try:
        r = requests.get(url, headers=UA, timeout=15)
        r.raise_for_status()
    except requests.RequestException as e:
        print(f"❌ fetch error {url}: {e}")
        return None

    m = PRICE_RE.search(r.text) or AMOUNT_RE.search(r.text)
    if not m:
        print(f"⚠️  no price found for {url}")
        return None

    price = _to_float(m.group(1))
    if price is None:
        print(f"⚠️  cannot parse price '{m.group(1)}' for {url}")
    return price


def telegram_send(message: str):
    if not (TELEGRAM_BOT and TELEGRAM_CHAT):
        print("⚠️  Telegram non configurato (mancano secret)")
        return
    api = f"https://api.telegram.org/bot{TELEGRAM_BOT}/sendMessage"
    try:
        requests.get(
            api,
            params={
                "chat_id": TELEGRAM_CHAT,
                "text": message,
                "parse_mode": "Markdown",
            },
            timeout=10,
        )
    except requests.RequestException as e:
        print(f"⚠️  telegram error: {e}")


def load_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def save_json(path: str, data):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"⚠️  impossibile scrivere {path}: {e}")


def commit_back(files):
    try:
        subprocess.run(
            ["git", "config", "user.email", "action@github.com"], check=False
        )
        subprocess.run(["git", "config", "user.name", "github-actions"], check=False)
        for fpath in files:
            subprocess.run(["git", "add", fpath], check=False)
        res = subprocess.run(["git", "diff", "--cached", "--quiet"], check=False)
        if res.returncode != 0:
            subprocess.run(
                ["git", "commit", "-m", "chore: update prices and config"], check=False
            )
            subprocess.run(["git", "push"], check=False)
            print("✅ file aggiornati e pushati")
    except Exception as e:  # pragma: no cover - defensive
        print(f"⚠️  commit error: {e}")


def main():
    if not os.path.exists(DATA_FILE):
        print("⚠️  products.json non trovato")
        sys.exit(0)

    products = load_json(DATA_FILE, None)
    if products is None:
        sys.exit(0)
    if not products:
        print("📭 Nessun prodotto da controllare.")
        sys.exit(0)

    config = load_json(CONFIG_FILE, {})
    try:
        interval = int(config.get("interval_minutes", 60))
    except (ValueError, TypeError):
        interval = 60
    if interval < 1:
        interval = 1

    last_run = config.get("last_run")
    now = datetime.now(timezone.utc)

    if not FORCE and last_run:
        try:
            last_dt = datetime.fromisoformat(last_run)
            elapsed = (now - last_dt).total_seconds() / 60.0
            if elapsed < interval:
                print(
                    f"⏳ Intervallo non ancora trascorso "
                    f"({elapsed:.0f}/{interval} min). Salto questo giro."
                )
                sys.exit(0)
        except (ValueError, TypeError):
            pass  # se il timestamp non è valido, controlliamo comunque

    for p in products:
        url = p.get("url")
        try:
            target = float(p.get("target_price", 0))
        except (ValueError, TypeError):
            print(f"⚠️  target non valido per {url}, salto")
            p["last_checked"] = now.isoformat()
            p["last_price"] = None
            continue

        price = fetch_price(url)
        p["last_checked"] = now.isoformat()
        p["last_price"] = price
        if price is None:
            continue
        print(f"💲 {url} → €{price:.2f} (target €{target:.2f})")
        if price <= target:
            msg = (
                f"🛒 *Price drop!*\n"
                f"URL: {url}\n"
                f"Prezzo attuale: *€{price:.2f}* (soglia €{target:.2f})"
            )
            telegram_send(msg)
            print("✅ alert inviato su Telegram")

    # aggiorna prodotti + timestamp dell'ultimo check real4e
    save_json(DATA_FILE, products)
    config["interval_minutes"] = interval
    config["last_run"] = now.isoformat()
    save_json(CONFIG_FILE, config)
    commit_back([DATA_FILE, CONFIG_FILE])


if __name__ == "__main__":
    main()
