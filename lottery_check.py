# -*- coding: utf-8 -*-
"""Проверка лотереи PancakeSwap: читает контракт BSC и шлёт алерт в Telegram.

Запускается на GitHub Actions. Зависимостей нет — только стандартная библиотека.
Переменные окружения: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PROXY (необязательно).
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

TICKETS_ALERT = 500
EDGE_ALERT = 0.50
MIN_TICKETS_PROJECTION = 20
STATE_FILE = "state.json"

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


def read_round():
    rid = int(rpc("0x" + sel("currentLotteryId()")), 16)
    raw = rpc("0x" + sel("viewLottery(uint256)") + format(rid, "064x"))
    body = raw[2:]
    v = [int(body[i:i + 64], 16) for i in range(0, len(body), 64)]
    return {"round": rid, "start": v[1], "end": v[2], "price": v[3] / 1e18,
            "tickets": v[25] - v[24], "pot": v[26] / 1e18}


def ev_calc(pot, tickets, price):
    if tickets <= 0:
        return price, 0.0
    ev = 0.0
    for i in range(6):
        pool = pot * SHARE[i]
        paid = pool * min(1.0, tickets * P_MATCH[i])
        ev += paid / tickets
    return ev, ev / price - 1


def notify(text):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat:
        print("нет TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID")
        return False
    body = json.dumps({"chat_id": chat, "text": text}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                                 data=body, headers={"Content-Type": "application/json"})
    proxy = os.environ.get("PROXY", "")
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy, "https": proxy})) if proxy else urllib.request.build_opener()
    try:
        with opener.open(req, timeout=25) as resp:
            return resp.status == 200
    except Exception as exc:
        print("Telegram:", exc)
        return False


def main():
    r = read_round()
    now = time.time()
    total = max(1, r["end"] - r["start"])
    frac = max(0.01, min(1.0, (now - r["start"]) / total))
    remaining = 1.0 - frac

    line = (f"раунд {r['round']} | прошло {frac*100:.0f}% | билетов {r['tickets']} | "
            f"банк {r['pot']:.0f} CAKE | цена {r['price']:.2f}")
    print(line)

    if r["tickets"] < MIN_TICKETS_PROJECTION:
        print("мало данных для прогноза")
        return

    projected = r["tickets"] / frac
    ev, edge = ev_calc(r["pot"], projected, r["price"])
    print(f"прогноз билетов {projected:.0f} | EV {ev:.2f} ({edge*100:+.0f}%)")

    if remaining > 0.35:
        print("рано: прогноз нестабильный")
        return
    if projected >= TICKETS_ALERT or edge <= EDGE_ALERT:
        print("условия не выполнены")
        return

    state = {}
    if os.path.exists(STATE_FILE):
        try:
            state = json.load(open(STATE_FILE))
        except Exception:
            state = {}
    if state.get("last_alert_round") == r["round"]:
        print("по этому раунду уже предупреждали")
        return

    end_dt = datetime.fromtimestamp(r["end"], timezone.utc).strftime("%d.%m %H:%M UTC")
    msg = (f"🎟 PancakeSwap Lottery, раунд {r['round']}\n"
           f"билетов: {r['tickets']} (прогноз к концу {projected:.0f})\n"
           f"банк: {r['pot']:.0f} CAKE\nбилет: {r['price']:.2f} CAKE\n"
           f"EV: {ev:.2f} CAKE ({edge*100:+.0f}%)\nконец раунда: {end_dt}")
    if notify(msg):
        print("алерт отправлен")
        state["last_alert_round"] = r["round"]
        state["sent_at"] = datetime.now(timezone.utc).isoformat()
        with open(STATE_FILE, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
