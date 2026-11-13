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
SEND_EVERY = 900           # интервал сообщений внутри часа
FAST_WINDOW = 900          # последние 15 минут — особый режим
FAST_SEND_EVERY = 60       # в них пишем каждую минуту
EDGE_GOOD = 0.50           # порог вердикта «играть»

BRACKET_LABELS = ["1 число", "2 числа", "3 числа", "4 числа", "5 чисел", "6 чисел"]

TIMEOUT_HINT = "билетов меньше 20 — прогноз не считается"
if os.name == "nt":
    STATE_FILE = r"D:\lottery-monitor-state.json"
    LOG_FILE = r"D:\lottery-monitor.log"
else:
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

    first_id = v[24]
    next_id = v[25]
    tickets = next_id - first_id

    # В живом раунде firstTicketIdNextLottery ещё не проставлен (равен 0),
    # поэтому считаем по глобальному счётчику currentTicketId.
    if tickets <= 0:
        try:
            current_id = int(rpc("0x" + sel("currentTicketId()")), 16)
            tickets = max(0, current_id - first_id)
        except Exception:
            tickets = 0

    return {"round": round_id, "start": v[1], "end": v[2], "price": v[3] / 1e18,
            "tickets": tickets, "pot": v[26] / 1e18}



def fmt_cake(value):
    """Число в формате 18 328.03"""
    return f"{value:,.2f}".replace(",", " ")


def read_finished_round(round_id):
    """Читает завершённый раунд: победители по корзинам и призы."""
    raw = rpc("0x" + sel("viewLottery(uint256)") + format(round_id, "064x"))
    body = raw[2:]
    v = [int(body[i:i + 64], 16) for i in range(0, len(body), 64)]
    return {
        "round": round_id,
        "status": v[0],                      # 0 pending, 1 open, 2 claimable, 3 closed
        "start": v[1],
        "end": v[2],
        "price": v[3] / 1e18,
        "pot": v[26] / 1e18,
        "final": v[27],
        "cake_per_bracket": [v[12 + i] / 1e18 for i in range(6)],
        "winners": [v[18 + i] for i in range(6)],
        "tickets": max(0, v[25] - v[24]),
    }


def build_results_text(info, skipped=0):
    lines = [f"🏆 Итоги раунда #{info['round']}", ""]
    if skipped:
        lines.append(f"⚠️ пропущено раундов: {skipped} (монитор не работал)")
        lines.append("")
    lines.append(f"🎫 Билетов: {info['tickets']}")
    lines.append(f"💰 Банк: {fmt_cake(info['pot'])} CAKE")
    lines.append(f"🔢 Победное число: {info['final']}")
    lines.append("")

    winners = info["winners"]
    prizes = info["cake_per_bracket"]
    total_winners = sum(winners)
    total_paid = 0.0
    rows = []
    for i in range(6):
        if winners[i] > 0:
            per = prizes[i]
            paid = per * winners[i]
            total_paid += paid
            rows.append(f"• {BRACKET_LABELS[i]} — {winners[i]} чел. × {fmt_cake(per)} = {fmt_cake(paid)} CAKE")

    if not rows:
        lines.append("😕 Победителей нет — банк перешёл в следующий раунд")
    else:
        lines.append("👥 Победители по корзинам:")
        lines.extend(rows)
        lines.append("")
        lines.append(f"Всего победителей: {total_winners}")
        suffix = ""
        if info["pot"] > 0:
            suffix = f" ({total_paid / info['pot'] * 100:.1f}% банка)"
        lines.append(f"Выплачено: {fmt_cake(total_paid)} CAKE{suffix}")

    return "\n".join(lines)


def report_results(force=False, dry=False):
    """Сообщает итоги последнего завершённого раунда (один раз на раунд)."""
    state = load_state()
    cur = int(rpc("0x" + sel("currentLotteryId()")), 16)
    last = state.get("last_results_round")

    if last is None:
        # первый запуск: не спамим историей, просто запоминаем предыдущий раунд
        state["last_results_round"] = cur - 1
        save_state(state)
        log(f"итоги: стартовая отметка — раунд {cur - 1} уже учтён")
        return

    target = cur - 1
    if target < 1:
        return
    if not force and target <= last:
        return
    if force and target < last:
        target = last

    skipped = 0 if force else max(0, target - last - 1)
    info = read_finished_round(target)
    if info["status"] not in (2, 3):
        log(f"итоги: раунд {target} ещё не завершён (status={info['status']})")
        return

    text = build_results_text(info, skipped)
    if dry:
        print("\n=== СООБЩЕНИЕ (не отправлено) ===")
        print(text)
        print("=================================")
    else:
        ok = notify(text)
        log(f"итоги раунда {target}: " + ("отправлено" if ok else "НЕ отправлено"))
        if not ok:
            return

    state["last_results_round"] = target
    save_state(state)


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
    # сначала проверяем, не завершился ли предыдущий раунд — шлём итоги
    try:
        report_results()
    except Exception as exc:
        log(f"итоги: {exc}")

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

    # в последние 15 минут пишем каждую минуту, до этого — раз в 15 минут
    fast_mode = remaining <= FAST_WINDOW
    send_every = FAST_SEND_EVERY if fast_mode else SEND_EVERY
    if not force and same_round and (now - last_ts) < send_every:
        log(f"раунд {r['round']}: окно открыто, ждём интервал ({int(send_every - (now - last_ts))} с)")
        return

    tickets = r["tickets"]
    minutes = int(remaining // 60)
    mark = "🔔 ФИНАЛЬНЫЕ МИНУТЫ · " if fast_mode else ""
    head = f"🎟 {mark}Раунд {r['round']} · до розыгрыша {minutes} мин"
    mid = f"билетов: {tickets}\nбанк: {r['pot']:.0f} CAKE · билет: {r['price']:.2f} CAKE"

    if tickets < 20:
        pool1 = r["pot"] * SHARE[0]
        cost = 10 * r["price"]
        verdict = (
            f"конкурентов почти нет.\n"
            f"Если взять 10 билетов с разными первыми цифрами (0–9), "
            f"первое число угадано гарантированно.\n"
            f"При нуле чужих билетов первая корзина ≈ {pool1:.0f} CAKE "
            f"за {cost:.0f} CAKE затрат.\n"
            f"Заходить только если и в последние минуты билетов не прибавилось."
        )
        text = f"{head}\n{mid}\n{verdict}"
    else:
        ev, edge = ev_calc(r["pot"], tickets, r["price"])
        share1 = (r["pot"] * SHARE[0]) / (tickets * 0.1)
        verdict = ("ИГРАТЬ: перевес в твою пользу" if edge > EDGE_GOOD
                   else "НЕ играть: перевес недостаточный")
        text = (f"{head}\n{mid}\nEV: {ev:.2f} CAKE ({edge*100:+.0f}%)\n"
                f"доля за 1 угаданное число: ≈{share1:.1f} CAKE\n{verdict}")

    log(f"раунд {r['round']}: отправляю (билетов {tickets}, осталось {minutes} мин)")
    if notify(text):
        state["last_sent_ts"] = now
        state["last_sent_round"] = r["round"]
        save_state(state)
        log("сообщение отправлено")


def main():
    if "--results" in sys.argv:
        report_results(force=True, dry="--dry" in sys.argv)
        return

    once = "--once" in sys.argv
    force = "--force" in sys.argv
    interval = int(os.environ.get("CHECK_INTERVAL", "60"))

    # сколько работать непрерывно: 0 = бесконечно (локальный режим)
    loop_hours = 0.0
    for arg in sys.argv:
        if arg.startswith("--loop-hours="):
            loop_hours = float(arg.split("=", 1)[1])
    if loop_hours <= 0 and "--loop-hours" in sys.argv:
        idx = sys.argv.index("--loop-hours")
        if idx + 1 < len(sys.argv):
            loop_hours = float(sys.argv[idx + 1])

    deadline = time.time() + loop_hours * 3600 if loop_hours > 0 else None
    if once:
        log("разовый прогон")
    elif deadline:
        log(f"цикл на {loop_hours:.1f} ч, интервал {interval} с")
    else:
        log(f"монитор запущен, интервал {interval} с")

    while True:
        try:
            check(force=force)
        except Exception as exc:
            log(f"ошибка цикла: {exc}")
        if once:
            return
        if deadline and time.time() >= deadline:
            log("время цикла вышло — завершаюсь")
            return
        time.sleep(interval)


if __name__ == "__main__":
    main()
