# 🛒 Amazon Price Alert (GitHub Pages + Actions)

Sistema **gratuito** per ricevere un alert su Telegram quando il prezzo di un
prodotto Amazon scende sotto la soglia che imposti. **Nessun PC acceso**:
tutto gira su GitHub (Actions + Pages).

## Cosa fa

- Una pagina web (GitHub Pages) dove aggiungi/rimuovi prodotti (URL + prezzo soglia).
- Un file `products.json` nel repo che fa da "database".
- Un workflow GitHub Actions (parte **ogni 15 minuti** ma rispetta l'intervallo
  che imposti in `config.json`: 15 min, 30 min, 1 ora … fino a 24 ore) che
  controlla i prezzi e ti manda un messaggio Telegram se il prezzo ≤ soglia.
- La pagina web può anche **scatenare subito il controllo** quando aggiungi un prodotto.

## Setup (una tantum)

### 1. Telegram

1. Scrivi a `@BotFather` su Telegram → `/newbot` → ottieni il **token**.
2. Avvia il tuo bot e scopri il tuo **chat ID** (es. con `@userinfobot`).

### 2. Fork/crea questo repo

- Metti i file (`products.json`, `config.json`, `manage.py`, `price_check.py`,
  `index.html`, `.github/workflows/price-check.yml`) nel tuo repo.
- `products.json` deve contenere solo `[]`; `config.json` contiene
  `{"interval_minutes": 60, "last_run": null}`.

### 3. Secrets su GitHub

In **Settings → Secrets and variables → Actions** aggiungi:

- `TELEGRAM_BOT` = il token del bot
- `TELEGRAM_CHAT` = il tuo chat ID

### 4. Abilita GitHub Pages

**Settings → Pages → Source: Deploy from a branch → `main` / root**.
Dopo qualche minuto la pagina sarà su `https://<owner>.github.io/<repo>/`.

### 5. Token per la pagina web

Nella pagina web, sezione ⚙️, inserisci:

- **Owner** e **Nome repo**
- **Branch** (`main`)
- Un **Personal Access Token** (classic) con permessi `repo` e `workflow`
  (servono per scrivere `products.json` e avviare il check).

Il token resta solo nel tuo browser (localStorage).

## Usare la pagina

- **➕ Aggiungi**: incolla l'URL Amazon (`/dp/...`) e il prezzo soglia → parte
  subito un controllo.
- **🗑️**: rimuove il prodotto.
- **💾 Salva frequenza** + menu a tendina: scegli l'intervallo (15 min, 30 min,
  1 ora, 2/3/6/12/24 ore). Il valore è salvato in `config.json`.
- **⚡ Check ora**: rilancia subito il controllo (ignora l'intervallo).
- **🔄 Aggiorna lista**: ricarica da `products.json` (mostra ultimo prezzo e data).

## Gestire da riga di comando (opzionale)

```bash
python manage.py add "https://www.amazon.com/dp/B0XXXX" 49.99
python manage.py list
python manage.py delete 1
python manage.py interval 30   # imposta l'intervallo a 30 minuti
python manage.py generate   # rigenera una index.html statica di sola lettura
```

## Note

- Il workflow parte **ogni 15 minuti** (`cron: "*/15 * * * *"`), ma salta i giri
  finché non è trascorso `interval_minutes` (default 60) da `last_run`. Cambia
  l'intervallo dalla pagina o con `manage.py interval <minuti>`; per forzare un
  check immediato usa il bottone **⚡ Check ora** (o `workflow_dispatch` con
  input `force: true`).
- Amazon a volte blocca richieste ripetute: il workflow logga gli errori ma
  non fallisce l'intero job.
- `price_check.py` riscrive `products.json` con `last_price` / `last_checked`
  e fa commit automatico (grazie al permesso `contents: write`).
