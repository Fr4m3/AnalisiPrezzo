#!/usr/bin/env python3
"""Minimal CLI to manage a list of products with target prices.
Data is stored in products.json (kept in the same repository).
Usage:
    python manage.py add <url> <target_price>
    python manage.py list
    python manage.py generate                # generates index.html for GitHub Pages
"""

import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # pragma: no cover - defensive
    pass

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "products.json")
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def load_products():
    try:
        with open(DATA_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_products(products):
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(products, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"⚠️ Errore scrittura file prodotti: {e}")


def is_valid_amazon_url(url: str) -> bool:
    """Very light validation – check that the URL looks like an Amazon product page."""
    return "amazon" in url.lower() and "/dp/" in url


def cmd_add(url: str, target_price: float):
    products = load_products()
    if not is_valid_amazon_url(url):
        print(
            "⚠️  URL doesn't look like an Amazon product link – adding anyway, but be aware."
        )
    # Store a simple dict; we keep the original order.
    products.append({"url": url, "target_price": target_price})
    save_products(products)
    print(f"✅ Product added: {url} (target €{target_price:.2f})")


def cmd_list():
    products = load_products()
    if not products:
        print("📭 No products stored yet.")
        return
    print("🛒 Your products:")
    for i, p in enumerate(products, start=1):
        print(f"{i}. {p['url']} – target price: €{p['target_price']:.2f}")


def cmd_delete(index: int):
    products = load_products()
    if index < 1 or index > len(products):
        print("⚠️ Indice non valido.")
        return
    removed = products.pop(index - 1)
    save_products(products)
    print(f"🗑️ Rimosso: {removed['url']}")


def load_config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_config(cfg):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"⚠️ Errore scrittura config: {e}")


def cmd_interval(minutes: int):
    cfg = load_config()
    cfg["interval_minutes"] = minutes
    save_config(cfg)
    print(f"✅ Intervallo impostato a {minutes} minuti")


def cmd_generate():
    products = load_products()
    html_parts = [
        "<!DOCTYPE html>",
        "<html lang='it'>",
        "<head>",
        "    <meta charset='UTF-8'>",
        "    <title>Monitoraggio Prezzi Amazon</title>",
        "    <style>",
        "        body { font-family: Arial, sans-serif; max-width: 800px; margin: 2rem auto; line-height: 1.6; }",
        "        h1 { text-align: center; color: #2c3e50; }",
        "        ul { list-style: none; padding: 0; }",
        "        li { margin: 1rem 0; padding: 0.5rem; background:#f8f9fa; border-radius:4px; }",
        "        a { color: #e74c3c; text-decoration:none; font-weight:bold; }",
        "        .meta { color: #7f8c8d; font-size:0.9rem; }",
        "    </style>",
        "</head>",
        "<body>",
        "    <h1>Prodotti in monitoraggio</h1>",
        "    <ul>",
    ]

    if not products:
        html_parts.append("        <li>Nessun prodotto al momento.</li>")
    else:
        for p in products:
            html_parts.append(
                f"        <li>"
                f"            <a href='{p['url']}' target='_blank'>{p['url']}</a>"
                f"            <span class='meta'>Prezzo target: €{p['target_price']:.2f}</span>"
                f"        </li>"
            )

    html_parts += ["    </ul>", "</body>", "</html>"]

    output_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "products_view.html"
    )
    try:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write("\n".join(html_parts))
    except OSError as e:
        print(f"⚠️ Errore generazione products_view.html: {e}")
    print(
        f"✅ products_view.html generato in {output_path} (pagina statica di sola lettura)"
    )


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python manage.py add <url> <target_price>")
        print("  python manage.py list")
        print("  python manage.py delete <num>")
        print("  python manage.py interval <minuti>")
        print("  python manage.py generate")
        sys.exit(1)

    command = sys.argv[1].lower()

    if command == "add":
        if len(sys.argv) != 4:
            print("Errore: sintassi 'add <url> <target_price>'")
            sys.exit(1)
        url = sys.argv[2]
        try:
            price = float(sys.argv[3])
        except ValueError:
            print("Errore: target price must be a number")
            sys.exit(1)
        cmd_add(url, price)
    elif command == "list":
        cmd_list()
    elif command == "delete":
        if len(sys.argv) != 3:
            print("Errore: sintassi 'delete <num>'")
            sys.exit(1)
        try:
            idx = int(sys.argv[2])
        except ValueError:
            print("Errore: l'indice deve essere un numero")
            sys.exit(1)
        cmd_delete(idx)
    elif command == "generate":
        cmd_generate()
    elif command == "interval":
        if len(sys.argv) != 3:
            print("Errore: sintassi 'interval <minuti>'")
            sys.exit(1)
        try:
            mins = int(sys.argv[2])
        except ValueError:
            print("Errore: i minuti devono essere un numero intero")
            sys.exit(1)
        cmd_interval(mins)
    else:
        print(f"Comando sconosciuto: {command}")
        sys.exit(1)


if __name__ == "__main__":
    main()
