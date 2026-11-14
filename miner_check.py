# -*- coding: utf-8 -*-
"""Внешняя проверка майнера Pearl через публичный API Kryptex Pool.

Работает на GitHub Actions: если ПК выключен / майнер стоит — пришлёт сообщение в Telegram.
  python miner_check.py            обычная проверка (для Actions)
  python miner_check.py --dry      только показать состояние
  python miner_check.py --test     отправить тестовое сообщение
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

WALLET = "prl1paaad8ne207t27a5uel2snnqkupy7lfuuvcwt7658g07ljerpd6ksn24krv"
WORKER = "rig1"
COIN = "prl"
API = f"https://pool.kryptex.com/{COIN}/api/v3/miner/workers/{WALLET}"
STATE_FILE = "miner-state.json"
OFFLINE_MINUTES = 20        # столько минут без шар — считаем, что майнер стоит
LOW_HASHRATE_RATIO = 0.25   # ниже 25% от среднего за 24ч — предупреждение


def fmt_hash(h):
    try:
        v = float(h)
    except (TypeError, ValueError):
        return "—"
    for unit in ("H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s"):
        if v < 1000:
            return f"{v:.2f} {unit}"
        v /= 1000
    return f"{v:.2f} EH/s"


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "miner-watch/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_worker():
    data = get_json(API)
    workers = data.get("results", []) if isinstance(data, dict) else []
    for w in workers:
        if w.get("worker") == WORKER:
            return w
    return None


def load_state():
    try:
        return json.load(open(STATE_FILE, encoding="utf-8"))
    except Exception:
        return {}


def save_state(s):
    try:
        json.dump(s, open(STATE_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    except Exception:
        pass


def send(text, dry=False):
    if dry:
        print("=== СООБЩЕНИЕ (не отправлено) ===")
        print(text)
        print("================================")
        return True
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat:
        print("НЕТ токена/чата")
        return False
    body = json.dumps({"chat_id": chat, "text": text,
                       "disable_web_page_preview": True}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                                 data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return resp.status == 200
    except Exception as exc:
        print("Telegram ошибка:", exc)
        return False


def main():
    dry = "--dry" in sys.argv
    now = datetime.now(timezone.utc)

    if "--test" in sys.argv:
        ok = send("🔔 Тест внешней проверки майнера\n\n"
                  "Это проверка связи из GitHub Actions. Пришлю сообщение, "
                  "если майнер rig1 уйдёт в офлайн или ПК будет выключен.", dry)
        print("тест:", "ok" if ok else "fail")
        return

    try:
        w = fetch_worker()
    except Exception as exc:
        # API недоступен — не паникуем, просто сообщаем, если долго
        print("ошибка API:", exc)
        return

    state = load_state()
    prev = state.get("status", "unknown")

    if not w:
        print("воркер не найден в ответе API")
        status = "offline"
        shares = 0
        h30 = h24 = None
        last_share_ts = None
    else:
        status = w.get("status", "offline")
        shares = int(w.get("valid", 0) or 0)
        h30 = w.get("avg_hashrate_30m")
        h24 = w.get("avg_hashrate_24h")
        last_share_ts = w.get("last_share")

    minutes_since_share = None
    if last_share_ts:
        try:
            minutes_since_share = (now.timestamp() * 1000 - float(last_share_ts)) / 60000.0
        except Exception:
            pass

    offline = (status != "online") or (minutes_since_share is not None and minutes_since_share > OFFLINE_MINUTES)

    print(f"состояние: {status} | шар: {shares} | 30м: {fmt_hash(h30)} | "
          f"24ч: {fmt_hash(h24)} | минут без шар: "
          f"{'—' if minutes_since_share is None else round(minutes_since_share, 1)} | offline={offline}")

    text = None
    if offline and prev != "offline":
        text = (f"🚨 Майнер не работает (внешняя проверка)\n\n"
                f"Воркер: {WORKER} (Pearl PRL)\n"
                f"Статус пула: {status}\n"
                f"Последняя шара: "
                f"{'нет данных' if minutes_since_share is None else str(round(minutes_since_share)) + ' мин назад'}\n"
                f"Хешрейт 30 мин: {fmt_hash(h30)}\n\n"
                f"ПК выключен, майнер остановлен или нет интернета.")
    elif not offline and prev == "offline":
        text = (f"✅ Майнер снова в сети (внешняя проверка)\n\n"
                f"Воркер: {WORKER}\n"
                f"Хешрейт 30 мин: {fmt_hash(h30)}\n"
                f"Действительных шар: {shares}")

    # предупреждение о падении хешрейта (только один раз, не чаще раза в 3 часа)
    if not offline and text is None and h30 and h24:
        try:
            ratio = float(h30) / float(h24) if float(h24) > 0 else 1.0
            last_low = state.get("last_low_alert", 0)
            if ratio < LOW_HASHRATE_RATIO and (now.timestamp() - last_low) > 3 * 3600:
                text = (f"⚠️ Хешрейт майнера упал\n\n"
                        f"Воркер: {WORKER}\n"
                        f"Сейчас (30 мин): {fmt_hash(h30)}\n"
                        f"Средний за 24 ч: {fmt_hash(h24)}\n"
                        f"Это {ratio * 100:.0f}% от обычного.\n\n"
                        f"Проверь: температуры, перегрев, падение драйвера.")
                state["last_low_alert"] = now.timestamp()
        except Exception:
            pass

    if text:
        ok = send(text, dry)
        print("сообщение:", "отправлено" if ok else "НЕ отправлено")

    state["status"] = "offline" if offline else "online"
    state["last_check"] = now.isoformat(timespec="seconds")
    state["last_hashrate_30m"] = h30
    state["last_hashrate_24h"] = h24
    state["last_shares"] = shares
    state["minutes_since_share"] = None if minutes_since_share is None else round(minutes_since_share, 1)
    save_state(state)


if __name__ == "__main__":
    main()
