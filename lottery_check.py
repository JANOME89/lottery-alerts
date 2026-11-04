# -*- coding: utf-8 -*-
"""Монитор лотереи PancakeSwap.

Правило уведомлений:
  • вне последнего часа перед розыгрышем — полная тишина
  • в последний час — сообщение каждые 15 минут
Работает и на GitHub Actions, и локально.
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

CONTRACT = "0x5aF6D33DE2ccEC94efb1bDF8f92Bd58085432d2c"
RPCS = ["https://bsc-dataseed.binance.org/",
        "https://bsc-dataseed1.defibit.io/",
        "https://bsc.publicnode.com"]

FINAL_WINDOW = 3600        # секунд до конца раунда, когда начинаем писать
SEND_EVERY = 900           # интервал сообщений внутри окна
EDGE_GOOD = 0.50           # порог вердикта «играть»

TIMEOUT_HINT = "билетов меньше 20 — прогноз не считается"
STATE_FILE = "state.json"
LOG_FILE = "lottery-monitor.log"

P_MATCH = [0.09, 0.009, 0.0009, 0.00009, 0.000009, 0.000001]
SHARE = [0.02, 0.03, 0.05, 0.10, 0.20, 0.40]

RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
      0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
      0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
      0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
      0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
      0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
       [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
MASK = (1 << 64) - 1


def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & MASK


def _keccak_f(a):
    for rnd in range(24):
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                a[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], ROT[x][y])
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
        a[0][0] ^= RC[rnd]
    return a


def keccak256(data):
    rate, msg = 136, bytearray(data)
    msg.append(0x01)
    while len(msg) % rate:
        msg.append(0x00)
    msg[-1] ^= 0x80
    st = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        for i in range(rate // 8):
            st[i % 5][i // 5] ^= int.from_bytes(msg[off + i * 8:off + i * 8 + 8], "little")
        st = _keccak_f(st)
    return b"".join(st[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


def sel(sig):
    return keccak256(sig.encode())[:4].hex()


def rpc(data):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                          "params": [{"to": CONTRACT, "data": data}, "latest"]}).encode()
    for url in RPCS:
        try:
            req = urllib.request.Request(url, data=payload, headers={
                "User-Agent": "lottery-check/1.0", "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=25) as resp:
                out = json.loads(resp.read())
            if out.get("result") and out["result"] != "0x":
                return out["result"]
        except Exception:
            continue
    raise RuntimeError("RPC недоступны")


def read_round(round_id=None):
    if round_id is None:
        round_id = int(rpc("0x" + sel("currentLotteryId()")), 16)
    raw = rpc("0x" + sel("viewLottery(uint256)") + format(round_id, "064x"))
    body = raw[2:]
    v = [int(body[i:i + 64], 16) for i in range(0, len(body), 64)]
    return {"round": round_id, "start": v[1], "end": v[2], "price": v[3] / 1e18,
            "tickets": v[25] - v[24], "pot": v[26] / 1e18}


def ev_calc(pot, tickets, price):
    ev = 0.0
    for i in range(6):
        pool = pot * SHARE[i]
        paid = pool * min(1.0, tickets * P_MATCH[i])
        ev += paid / tickets
    return ev, ev / price - 1


def creds():
    import re
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat = os.environ.get("TELEGRAM_CHAT_ID", "")
    if token and chat:
        return token, chat
    try:
        text = open(r"C:\AINews\run_agent.bat", encoding="utf-8", errors="ignore").read()
        mt = re.search(r'TELEGRAM_BOT_TOKEN=([^\s"]+)', text)
        mc = re.search(r'TELEGRAM_CHAT_ID=([^\s"]+)', text)
        if mt and mc:
            return mt.group(1), mc.group(1)
    except Exception:
        pass
    return token, chat


def notify(text):
    token, chat = creds()
    if not token or not chat:
        log("нет токена/чата для Telegram")
        return False
    body = json.dumps({"chat_id": chat, "text": text}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                                 data=body, headers={"Content-Type": "application/json"})
    proxy = os.environ.get("PROXY", "")
    opener = (urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
        if proxy else urllib.request.build_opener())
    try:
        with opener.open(req, timeout=25) as resp:
            return resp.status == 200
    except Exception as exc:
        log(f"Telegram: {exc}")
        return False


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def save_state(state):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=2)
    except Exception:
        pass


def check(force=False):
    r = read_round()
    now = time.time()
    remaining = r["end"] - now

    if remaining <= 0:
        log(f"раунд {r['round']} закрыт, ждём новый")
        return
    if remaining > FINAL_WINDOW and not force:
        log(f"раунд {r['round']}: до розыгрыша {remaining/3600:.1f} ч — молчим")
        return

    state = load_state()
    last_ts = state.get("last_sent_ts", 0)
    same_round = state.get("last_sent_round") == r["round"]
    if not force and same_round and (now - last_ts) < SEND_EVERY:
        log(f"раунд {r['round']}: окно открыто, ждём интервал ({int(SEND_EVERY - (now - last_ts))} с)")
        return

    tickets = r["tickets"]
    minutes = int(remaining // 60)
    head = f"🎟 Раунд {r['round']} · до розыгрыша {minutes} мин"
    mid = f"билетов: {tickets}\nбанк: {r['pot']:.0f} CAKE · билет: {r['price']:.2f} CAKE"

    if tickets < 20:
        verdict = "билетов почти нет — считать нечего, ставку не рекомендую"
        text = f"{head}\n{mid}\n{verdict}"
    else:
        ev, edge = ev_calc(r["pot"], tickets, r["price"])
        verdict = ("ИГРАТЬ: перевес в твою пользу" if edge > EDGE_GOOD
                   else "НЕ играть: перевес недостаточный")
        text = (f"{head}\n{mid}\nEV: {ev:.2f} CAKE ({edge*100:+.0f}%)\n{verdict}")

    log(f"раунд {r['round']}: отправляю (билетов {tickets}, осталось {minutes} мин)")
    if notify(text):
        state["last_sent_ts"] = now
        state["last_sent_round"] = r["round"]
        save_state(state)
        log("сообщение отправлено")


def main():
    once = "--once" in sys.argv
    interval = int(os.environ.get("CHECK_INTERVAL", "60"))
    log("монитор запущен" + (" (разовый прогон)" if once else f", интервал {interval} с"))
    while True:
        try:
            check(force=once)
        except Exception as exc:
            log(f"ошибка цикла: {exc}")
        if once:
            return
        time.sleep(interval)


if __name__ == "__main__":
    main()
