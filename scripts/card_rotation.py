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
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
CARDS_FILE = Path(os.environ.get("YAMADA_CARDS_FILE", "") or (ROOT_DIR / "cards.json")).expanduser()


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


def apply_card_rotation(profile: dict, row_number: object) -> dict:
    """Ghi đè credit_card_* trong profile bằng thẻ xoay theo dòng. Ưu tiên hơn Excel."""
    card = pick_card(row_number)
    if card:
        profile.update(card)
    return profile
