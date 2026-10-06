"""Chọn thẻ SANDBOX/TEST cho flow Gold (thay cho cột credit_card_* trong Excel).

Thẻ KHÔNG lưu trong mã nguồn. Chúng được nạp từ file JSON ngoài (mặc định
`cards.json` ở gốc repo, đổi được bằng env YAMADA_CARDS_FILE). Đây là thẻ test
của cổng thanh toán sandbox, không phải thẻ thật.

Chọn thẻ theo DEVICE khi batch truyền danh sách thiết bị:
    primary card = CARDS[index của device trong danh sách device]
Ví dụ 10 thiết bị + 16 thẻ -> 10 thẻ đầu là thẻ chính cố định cho 10 máy,
6 thẻ còn lại là fallback khi HTML báo thẻ bị từ chối/khoá.

Nếu không có context device thì giữ fallback cũ theo SỐ DÒNG Excel để các lệnh
chạy lẻ vẫn hoạt động.

Định dạng cards.json (xem cards.example.json): danh sách object, mỗi thẻ 3 trường
`credit_card_number`, `credit_card_exp` (MM/YY), `credit_card_cvv`. Nếu file
không tồn tại/trống -> không xoay, flow rơi về cột Excel như cũ.
"""

from __future__ import annotations

import json
import os
import re
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
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

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


def split_device_ids(value: object) -> list[str]:
    return [part.strip() for part in re.split(r"[,\s]+", str(value or "").strip()) if part.strip()]


def device_ids_from_context(device_ids: object = None) -> list[str]:
    if device_ids is None:
        device_ids = os.environ.get("YAMADA_CARD_DEVICE_IDS", "")
    if isinstance(device_ids, (list, tuple, set)):
        return [str(item).strip() for item in device_ids if str(item).strip()]
    return split_device_ids(device_ids)


def card_index_for_row(row_number: object, card_count: int) -> int:
    if card_count <= 0:
        return 0
    try:
        return (int(row_number) - 2) % card_count
    except (TypeError, ValueError):
        return 0


def primary_card_count(cards: list[dict], device_ids: list[str]) -> int:
    if not cards:
        return 0
    if device_ids:
        return min(len(device_ids), len(cards))
    return len(cards)


def card_index_for_device(device_id: object, device_ids: list[str], card_count: int) -> int | None:
    if card_count <= 0 or not device_ids:
        return None
    raw = str(device_id or "").strip()
    if raw in device_ids:
        return device_ids.index(raw) % card_count
    return None


def pick_card(
    row_number: object,
    *,
    device_id: object = "",
    device_ids: object = None,
    offset: int = 0,
) -> dict:
    """Trả về thẻ chính cho device; thiếu context device thì fallback theo dòng Excel."""
    cards = load_cards()
    if not cards:
        return {}
    devices = device_ids_from_context(device_ids)
    primary_count = primary_card_count(cards, devices)
    idx = card_index_for_device(device_id, devices, primary_count)
    if idx is None:
        idx = card_index_for_row(row_number, len(cards))
    idx = (idx + int(offset or 0)) % len(cards)
    return dict(cards[idx])


def pick_alternate_card(
    row_number: object,
    current_card: dict | None = None,
    *,
    device_id: object = "",
    device_ids: object = None,
) -> dict:
    """Pick 1 thẻ fallback, khác thẻ hiện tại. Trả {} nếu pool không còn thẻ khác."""
    cards = load_cards()
    if len(cards) <= 1:
        return {}

    current_key = card_key(current_card or {}) if current_card else ""
    devices = device_ids_from_context(device_ids)
    primary_count = primary_card_count(cards, devices)
    fallback_cards = cards[primary_count:] if devices and primary_count < len(cards) else []
    candidate_pool = fallback_cards or cards

    if fallback_cards:
        device_index = card_index_for_device(device_id, devices, primary_count) or 0
        start_idx = (card_index_for_row(row_number, len(candidate_pool)) + device_index) % len(candidate_pool)
    else:
        start_idx = card_index_for_row(row_number, len(candidate_pool))
        if current_key:
            for index, card in enumerate(candidate_pool):
                if card_key(card) == current_key:
                    start_idx = index
                    break

    for offset in range(0 if fallback_cards else 1, len(candidate_pool) + (0 if fallback_cards else 1)):
        candidate = dict(candidate_pool[(start_idx + offset) % len(candidate_pool)])
        if not current_key or card_key(candidate) != current_key:
            return candidate

    if current_key:
        for index, card in enumerate(cards):
            if card_key(card) != current_key:
                return dict(card)
    return {}


def card_cooldown_seconds() -> float:
    raw = os.environ.get("YAMADA_CARD_COOLDOWN_SECONDS", "3")
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        seconds = 3.0
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


def apply_card_rotation(
    profile: dict,
    row_number: object,
    *,
    device_id: object = "",
    device_ids: object = None,
    wait_cooldown: bool = True,
) -> dict:
    """Ghi đè credit_card_* trong profile bằng thẻ chính theo device. Ưu tiên hơn Excel."""
    card = pick_card(row_number, device_id=device_id, device_ids=device_ids)
    if card:
        if wait_cooldown:
            wait_for_card_cooldown(card, row_number)
        profile.update(card)
    return profile
