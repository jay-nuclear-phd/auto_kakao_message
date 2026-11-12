"""3반 결강 현황 보고 문구를 만들어 카카오톡 방에 보낸다.

Windows 작업 스케줄러에서 실행한다 (일~목 16:00 초안, 월~금 07:00 최종).
  pythonw.exe kakao_report.py --kind draft     # 내일 현황 초안 (내일이 근무일일 때만)
  pythonw.exe kakao_report.py --kind final     # 오늘 현황 최종
  python.exe  kakao_report.py --kind draft --dry-run   # 보내지 않고 문구만 출력

받는 방은 automation/config.json 의 "room" (창 제목과 정확히 일치해야 함).
건너뛸 날짜(공휴일 등)는 automation/skip_dates.txt 에 YYYY-MM-DD 로 한 줄씩.

문구 규칙은 docs/index.html 의 buildMessage 와 같아야 한다. 바꿀 때는 둘 다 바꾼다.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import traceback
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CONFIG_PATH = HERE / "config.json"
SKIP_PATH = HERE / "skip_dates.txt"
LOG_PATH = HERE / "logs" / "report.log"
SEND_PS1 = ROOT / "kakao_send.ps1"

DEFAULT_REASONS = [
    {"name": "육아시간", "type": "time"},
    {"name": "청원휴가", "type": "leave"},
    {"name": "자녀돌봄", "type": "time"},
]
DRAFT_ALWAYS = ["육아시간"]
ITEM_ORDER = ["육아시간", "모성보호시간", "자녀돌봄"]
LETTERS = "가나다라마바사아자차카타파하"
WD = ["월", "화", "수", "목", "금", "토", "일"]  # date.weekday() 순서
KST = dt.timezone(dt.timedelta(hours=9))
SITE_URL = "https://jay-nuclear-phd.github.io/auto_kakao_message/"


def log(msg: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    line = f"{dt.datetime.now(KST):%Y-%m-%d %H:%M:%S} {msg}"
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    try:
        print(line)
    except Exception:  # pythonw 에는 콘솔이 없음
        pass


def load_config() -> dict:
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    for k in ("api_url", "room", "unit"):
        if not cfg.get(k):
            raise SystemExit(f"config.json 에 {k} 가 없음")
    return cfg


def skip_dates() -> set[str]:
    if not SKIP_PATH.exists():
        return set()
    out = set()
    for line in SKIP_PATH.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*(\d{4}-\d{2}-\d{2})", line)
        if m:
            out.add(m.group(1))
    return out


# ---------- 시간 표현 ----------
def norm_time(t: str) -> str:
    m = re.match(r"^(\d{1,2}):(\d{2})", str(t or ""))
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else ""


def parse_ranges(times: str) -> list[tuple[str, str]]:
    out = []
    for r in str(times or "").split(","):
        parts = r.split("~")
        if len(parts) != 2:
            continue
        a, b = norm_time(parts[0]), norm_time(parts[1])
        if a and b and a < b:
            out.append((a, b))
    return out


LUNCH = (12 * 60, 13 * 60)  # 점심시간은 결강 시간에서 뺀다
WORK = (8 * 60 + 30, 17 * 60 + 30)


def to_min(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def mins_of(times: str, within: tuple[int, int] | None = None) -> int:
    total = 0
    for a, b in parse_ranges(times):
        s, t = to_min(a), to_min(b)
        if within:
            s, t = max(s, within[0]), min(t, within[1])
            if t <= s:
                continue
        total += (t - s) - max(0, min(t, LUNCH[1]) - max(s, LUNCH[0]))
    return total


def is_full_day(times: str) -> bool:
    """08:30~17:30 (점심 제외 8시간)을 모두 덮으면 하루 전체 휴가."""
    return mins_of(times, WORK) >= (WORK[1] - WORK[0]) - (LUNCH[1] - LUNCH[0])


def disp_times(times: str) -> str:
    return ", ".join(f"{a}~{b}" for a, b in parse_ranges(times))


def norm_entry(e: dict) -> dict:
    times = e.get("times") or (f"{e['start']}~{e['end']}" if e.get("start") and e.get("end") else "")
    return {
        "date": str(e.get("date", ""))[:10],
        "name": str(e.get("name", "")),
        "status": e.get("status"),
        "reason": e.get("reason") or "",
        "times": ",".join(f"{a}~{b}" for a, b in parse_ranges(times)),
    }


# ---------- 데이터 ----------
def fetch(api_url: str, date: str) -> tuple[list[dict], dict]:
    q = urllib.parse.urlencode({"action": "list", "from": date, "to": date})
    req = urllib.request.Request(f"{api_url}?{q}", headers={"User-Agent": "kakao-report"})
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.loads(r.read().decode("utf-8"))
    if not j.get("ok"):
        raise RuntimeError(j.get("error") or "불러오기 실패")
    return [norm_entry(e) for e in j.get("entries", [])], j.get("config") or {}


# ---------- 문구 (docs/index.html buildMessage 와 동일) ----------
def report_date(d: dt.date) -> str:
    return f"'{d.year % 100:02d}.{d.month}.{d.day}.({WD[d.weekday()]})"


def build_message(date: str, kind: str, entries: list[dict], config: dict, unit: str) -> str:
    extra = [r for r in (config.get("reasons") or []) if not any(d["name"] == r.get("name") for d in DEFAULT_REASONS)]
    reasons = DEFAULT_REASONS + extra
    rtype = lambda n: next((r["type"] for r in reasons if r["name"] == n), "time")  # noqa: E731
    total = int(config.get("total") or 45)

    def first_start(e):
        rs = parse_ranges(e["times"])
        return rs[0][0] if rs else ""

    key = lambda e: (first_start(e), e["name"])  # noqa: E731
    absent = [e for e in entries if e["date"] == date and e["status"] == "absent"]
    is_leave = lambda e: rtype(e["reason"]) == "leave" and is_full_day(e["times"])  # noqa: E731
    leave_n = sum(1 for e in absent if is_leave(e))  # 출근에서 빼는 사람은 종일 휴가자만
    groups: dict[str, list] = {n: [] for n in (DRAFT_ALWAYS if kind == "draft" else [])}
    for e in absent:
        groups.setdefault(e["reason"], []).append(e)
    # 휴가 유형(반일 포함)을 먼저, 그다음 시간 사용 항목
    rank = lambda n: (0 if rtype(n) == "leave" else 100) + (ITEM_ORDER.index(n) if n in ITEM_ORDER else 99)  # noqa: E731
    ordered = sorted(groups.items(), key=lambda kv: (rank(kv[0]), kv[0]))

    items = [f"출근현황 : 총원 {total}명, {f'휴가 {leave_n}명, ' if leave_n else ''}출근 {total - leave_n}명"]
    for r, lst in ordered:
        lst.sort(key=key)
        items.append("\n".join([f"{r} : {len(lst)}명"] + [f" * {e['name']}({disp_times(e['times'])})" for e in lst]))
    items.append("건강상태 : 이상무")

    d = dt.date.fromisoformat(date)
    body = f"{report_date(d)}  <{unit}>\n" + "\n".join(f"{LETTERS[i]}. {t}" for i, t in enumerate(items))
    link = f"\n\n결강 입력: {SITE_URL}"
    if kind == "draft":
        return f"저는 김주연 소령(봇) 입니다. \n이 메세지는 매일 16시에 발송됩니다.\n전날 기준 현황은 다음과 같습니다. \n\n{body}\n\n변경 사항있다면 아래 링크로 의견 부탁드립니다!{link}"
    return f"저는 김주연 소령(봇) 입니다. \n이 메세지는 매일 07시에 발송됩니다.\n\n{body}\n\n더 이상 변경 사항이 없으면 위에 현황으로 보고하겠습니다!\n추가 변경사항은 아래의 링크에서 입력해주시기 바랍니다.{link}"


# ---------- 전송 ----------
def send(room: str, text: str) -> None:
    fd, path = tempfile.mkstemp(prefix="kakao_msg_", suffix=".txt")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
             "-File", str(SEND_PS1), "-Title", room, "-TextFile", path],
            capture_output=True, timeout=120, creationflags=flags,
        )
        out = (r.stdout + r.stderr).decode("utf-8", "replace").strip()
        if r.returncode != 0 or "sent to" not in out:
            raise RuntimeError(f"전송 실패 (code {r.returncode}): {out}")
        log(f"  {out.splitlines()[-1]}")
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", choices=["draft", "final"], required=True)
    ap.add_argument("--date", help="대상 날짜 YYYY-MM-DD (기본: draft=내일, final=오늘)")
    ap.add_argument("--room", help="config.json 의 room 대신 보낼 방")
    ap.add_argument("--dry-run", action="store_true", help="보내지 않고 문구만 출력")
    ap.add_argument("--force", action="store_true", help="대상이 주말/건너뛸 날짜여도 실행")
    a = ap.parse_args()

    cfg = load_config()
    room = a.room or cfg["room"]
    today = dt.datetime.now(KST).date()
    skips = skip_dates()

    # draft = 내일 현황 (일~목 16시 → 월~금), final = 오늘 현황 (월~금 07시)
    target = dt.date.fromisoformat(a.date) if a.date else today + dt.timedelta(days=1 if a.kind == "draft" else 0)
    if not a.force and (target.weekday() >= 5 or target.isoformat() in skips):
        log(f"[{a.kind}] 대상 {target}은 주말/건너뛰는 날이라 보내지 않음")
        return 0

    try:
        entries, config = fetch(cfg["api_url"], target.isoformat())
        text = build_message(target.isoformat(), a.kind, entries, config, cfg["unit"])
        log(f"[{a.kind}] 대상 {target} → '{room}' ({'dry-run' if a.dry_run else '전송'})")
        if a.dry_run:
            print(text)
            return 0
        send(room, text)
        log(f"[{a.kind}] 완료")
        return 0
    except Exception as e:  # noqa: BLE001
        log(f"[{a.kind}] 오류: {e}\n{traceback.format_exc()}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
