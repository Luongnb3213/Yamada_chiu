"""Xoay vòng thẻ SANDBOX/TEST cho flow Gold (thay cho cột credit_card_* trong Excel).

Thẻ KHÔNG lưu trong mã nguồn. Chúng được nạp từ file JSON ngoài (mặc định
`cards.json` ở gốc repo, đổi được bằng env YAMADA_CARDS_FILE). Đây là thẻ test
của cổng thanh toán sandbox, không phải thẻ thật.

Chọn thẻ theo SỐ DÒNG Excel:
    card = CARDS[(row - 2) % len(CARDS)]
=> tất định, an toàn khi chạy song song nhiều device và khi chạy lại dòng lỗi
(mỗi nick luôn dùng đúng một thẻ, không "nhảy thẻ" giữa các lần retry).

Định dạng cards.json (xem cards.example.json): danh sách object, mỗi thẻ 3 trường
`credit_card_number`, `credit_card_exp` (MM/YY), `credit_card_cvv`. Nếu file
không tồn tại/trống -> không xoay, flow rơi về cột Excel như cũ.
"""

from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from typing import Iterator


ROOT_DIR = Path(__file__).resolve().parents[1]
CARDS_FILE = Path(os.environ.get("YAMADA_CARDS_FILE", "") or (ROOT_DIR / "cards.json")).expanduser()
RUNTIME_DIR = ROOT_DIR / "agents" / "runtime"
CARD_COOLDOWN_STATE_FILE = Path(
    os.environ.get("YAMADA_CARD_COOLDOWN_STATE_FILE", "")
    or (RUNTIME_DIR / "card_cooldowns.json")
).expanduser()
CARD_COOLDOWN_LOCK_FILE = Path(
    os.environ.get("YAMADA_CARD_COOLDOWN_LOCK_FILE", "")
    or (RUNTIME_DIR / "card_cooldowns.lock")
).expanduser()


@contextmanager
def exclusive_lock(path: Path) -> Iterator[None]:
    import fcntl

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def load_cards() -> list[dict]:
    try:
        if not CARDS_FILE.exists():
            return []
        data = json.loads(CARDS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    cards: list[dict] = []
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict):
            continue
        number = str(item.get("credit_card_number") or item.get("card_number") or "").strip()
        exp = str(item.get("credit_card_exp") or item.get("card_exp") or "").strip()
        cvv = str(item.get("credit_card_cvv") or item.get("card_cvv") or item.get("cvv") or "").strip()
        if number and exp and cvv:
            cards.append(
                {
                    "credit_card_number": number,
                    "credit_card_exp": exp,
                    "credit_card_cvv": cvv,
                }
            )
    return cards


def pick_card(row_number: object) -> dict:
    """Trả về thẻ cho dòng Excel `row_number` (dòng dữ liệu đầu tiên = 2 -> thẻ 0)."""
    cards = load_cards()
    if not cards:
        return {}
    try:
        idx = (int(row_number) - 2) % len(cards)
    except (TypeError, ValueError):
        idx = 0
    return dict(cards[idx])


def card_cooldown_seconds() -> float:
    raw = os.environ.get("YAMADA_CARD_COOLDOWN_SECONDS", "30")
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        seconds = 30.0
    return max(0.0, seconds)


def card_key(card: dict) -> str:
    raw = "|".join(
        str(card.get(key) or "").strip()
        for key in ("credit_card_number", "credit_card_exp", "credit_card_cvv")
    )
    return sha256(raw.encode("utf-8")).hexdigest()[:16]


def masked_card(card: dict) -> str:
    number = "".join(ch for ch in str(card.get("credit_card_number") or "") if ch.isdigit())
    if len(number) >= 4:
        return "****" + number[-4:]
    return "****"


def load_cooldown_state() -> dict:
    try:
        if not CARD_COOLDOWN_STATE_FILE.exists():
            return {}
        data = json.loads(CARD_COOLDOWN_STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_cooldown_state(state: dict) -> None:
    CARD_COOLDOWN_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CARD_COOLDOWN_STATE_FILE.with_suffix(CARD_COOLDOWN_STATE_FILE.suffix + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CARD_COOLDOWN_STATE_FILE)


def wait_for_card_cooldown(card: dict, row_number: object) -> None:
    cooldown = card_cooldown_seconds()
    if cooldown <= 0 or not card:
        return

    key = card_key(card)
    row_value = str(row_number or "").strip()
    wait_seconds = 0.0
    scheduled_at = time.time()

    with exclusive_lock(CARD_COOLDOWN_LOCK_FILE):
        state = load_cooldown_state()
        cards_state = state.setdefault("cards", {})
        entry = cards_state.get(key)
        if not isinstance(entry, dict):
            entry = {}

        now = time.time()
        last_row = str(entry.get("last_row") or "").strip()
        if last_row == row_value:
            scheduled_at = now
        else:
            next_available = float(entry.get("next_available_at") or 0)
            scheduled_at = max(now, next_available)
            wait_seconds = max(0.0, scheduled_at - now)

        entry.update(
            {
                "masked": masked_card(card),
                "last_row": row_value,
                "last_scheduled_at": scheduled_at,
                "next_available_at": scheduled_at + cooldown,
            }
        )
        cards_state[key] = entry
        state["updated_at"] = now
        save_cooldown_state(state)

    if wait_seconds > 0:
        print(f"[card] {masked_card(card)} chờ {wait_seconds:.0f}s cooldown trước khi dùng.", flush=True)
        time.sleep(wait_seconds)


def apply_card_rotation(profile: dict, row_number: object, *, wait_cooldown: bool = True) -> dict:
    """Ghi đè credit_card_* trong profile bằng thẻ xoay theo dòng. Ưu tiên hơn Excel."""
    card = pick_card(row_number)
    if card:
        if wait_cooldown:
            wait_for_card_cooldown(card, row_number)
        profile.update(card)
    return profile
