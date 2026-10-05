from __future__ import annotations

import argparse
import email
import json
import re
import sys
import time
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import imaplib  # noqa: E402

import src.config as config  # noqa: E402
from chiu_profile_from_excel import load_row, profile_from_record, write_profile_js  # noqa: E402
from src.core.email_reader_imap import (  # noqa: E402
    _body_text,
    _get_imap_server,
    _list_mailboxes,
    _message_ts,
    _sender_matches,
    _target_matches,
)


YAMADA_FROM = "noreply@tpgaw.jp,noreply@ml.yamada-denki.jp"
LOGIN_URL_PATTERN = re.compile(
    r"https?://[^\s<>'\"]*module=changephone[^\s<>'\"]*action=chg003[^\s<>'\"]*",
    re.I,
)


def read_source(args: argparse.Namespace) -> tuple[dict, dict]:
    if not args.xlsx:
        email_value = args.email.strip()
        if not email_value:
            raise RuntimeError("Need --email or --xlsx.")
        return {"email": email_value}, {}

    xlsx_path = Path(args.xlsx).expanduser()
    if not xlsx_path.exists():
        raise RuntimeError(f"XLSX not found: {xlsx_path}")
    record, row_number, sheet_name = load_row(xlsx_path, args.sheet, args.row, args.email)
    profile = profile_from_record(record)
    source = {"xlsx": str(xlsx_path), "sheet": sheet_name, "row": row_number}
    return {**record, **profile}, source


def resolve_mailbox(args: argparse.Namespace, record: dict) -> tuple[str, str, str]:
    target_email = str(args.email or record.get("email") or "").strip()
    inbox = (
        args.inbox
        or str(record.get("otp_email") or record.get("otp_inbox") or "").strip()
        or str(getattr(config, "CATCHALL_INBOX", "") or "").strip()
        or target_email
    )
    password = (
        args.password
        or str(record.get("otp_pass") or record.get("otp_password") or "").strip()
        or str(getattr(config, "CATCHALL_PASSWORD", "") or "").strip()
    )
    if not password and not args.no_row_password and inbox.lower() == target_email.lower():
        password = str(record.get("password") or "").strip()
    imap_host = (
        args.imap_host
        or str(record.get("otp_imap_host") or "").strip()
        or str(getattr(config, "IMAP_HOST", "") or "").strip()
    )
    return inbox, password, imap_host


def clean_url(value: str) -> str:
    return str(value or "").strip().rstrip(").,;]\r\n")


def find_login_url_imap(
    *,
    target_email: str,
    inbox: str,
    password: str,
    imap_host: str,
    from_filter: str,
    timeout: int,
    since_ts: float,
    poll_interval: int,
) -> str:
    imap_server = _get_imap_server(inbox, imap_host=imap_host)
    if not imap_server:
        raise RuntimeError(f"Không biết IMAP host cho {inbox}.")

    senders = [item.strip() for item in re.split(r"[,;]", str(from_filter or "")) if item.strip()]
    search_expr = f'(FROM "{senders[0]}")' if len(senders) == 1 else "ALL"
    deadline = time.time() + timeout
    seen: set[str] = set()

    while time.time() < deadline:
        try:
            mail = imaplib.IMAP4_SSL(imap_server)
            mail.login(inbox, password)
            try:
                for mailbox in _list_mailboxes(mail):
                    try:
                        selected, _ = mail.select(f'"{mailbox}"', readonly=True)
                        if selected != "OK":
                            continue
                    except Exception:
                        continue
                    status, messages = mail.search(None, search_expr)
                    if status != "OK" or not messages or not messages[0]:
                        continue
                    for num in reversed(messages[0].split()[-60:]):
                        res, msg_data = mail.fetch(num, "(BODY.PEEK[])")
                        if res != "OK":
                            continue
                        raw = next((part[1] for part in msg_data if isinstance(part, tuple)), None)
                        if not raw:
                            continue
                        msg = email.message_from_bytes(raw)
                        key = str(msg.get("Message-ID") or f"{mailbox}:{num!r}")
                        if key in seen:
                            continue
                        seen.add(key)
                        if since_ts and _message_ts(msg) < since_ts:
                            continue
                        body = _body_text(msg)
                        if not _sender_matches(from_filter, msg):
                            continue
                        if not _target_matches(target_email, msg, body):
                            continue
                        match = LOGIN_URL_PATTERN.search(body)
                        if match:
                            return clean_url(match.group(0))
            finally:
                mail.logout()
        except imaplib.IMAP4.error as exc:
            raise RuntimeError(f"Lỗi đăng nhập IMAP {inbox}: {exc}") from exc
        except Exception:
            pass
        time.sleep(max(1, poll_interval))
    return ""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fetch fresh Yamada login URL from IMAP for Yamada_chiu.")
    parser.add_argument("--xlsx", default="")
    parser.add_argument("--sheet", default=str(getattr(config, "ACTIVE_SHEET", "Accounts") or "Accounts"))
    parser.add_argument("--row", type=int)
    parser.add_argument("--email", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--password", default="")
    parser.add_argument("--imap-host", default="")
    parser.add_argument("--no-row-password", action="store_true")
    parser.add_argument("--from-filter", default=YAMADA_FROM)
    parser.add_argument("--timeout", type=int, default=int(getattr(config, "EMAIL_OTP_TIMEOUT", 120)))
    parser.add_argument("--poll-interval", type=int, default=5)
    parser.add_argument("--since-ts", type=float, default=0)
    parser.add_argument("--allow-old", action="store_true")
    parser.add_argument("--profile-js", default="")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        record, source = read_source(args)
        target_email = str(args.email or record.get("email") or "").strip()
        if not target_email:
            raise RuntimeError("Missing target email.")
        inbox, password, imap_host = resolve_mailbox(args, record)
        if not inbox or not password:
            raise RuntimeError("Missing IMAP inbox/password.")
        since_ts = args.since_ts
        if not since_ts and not args.allow_old:
            since_ts = time.time() - int(getattr(config, "EMAIL_CLOCK_SKEW_MARGIN", 180))

        login_url = find_login_url_imap(
            target_email=target_email,
            inbox=inbox,
            password=password,
            imap_host=imap_host,
            from_filter=args.from_filter,
            timeout=args.timeout,
            since_ts=since_ts,
            poll_interval=args.poll_interval,
        )
        if not login_url:
            raise RuntimeError("Không lấy được login URL từ email.")

        result = {
            "ok": True,
            "email": target_email,
            "inbox": inbox,
            "imap_host": imap_host,
            "from_filter": args.from_filter,
            "login_url": login_url,
            "source": source,
        }
        if args.profile_js:
            profile = profile_from_record(record)
            profile["email"] = target_email
            profile["login_url"] = login_url
            profile["login_url_source"] = "email_fresh"
            write_profile_js(profile, Path(args.profile_js).expanduser())
            result["profile_js"] = args.profile_js
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(f"[email-login-url] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
