"""Collect limited, publicly visible squid schedules from verified Sunsang24 fleets.

This collector uses the first-party public monthly JSON route documented in
API_SOURCES.md. It never logs in, submits reservations, guesses IDs, or bypasses
blocks. If the source changes or blocks requests, it exits without replacing
the last good snapshot.
"""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
import sys
import time
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parent
REGISTRY_PATH = ROOT / "source_registry.json"
OUTPUT_PATH = ROOT / "fishing_data.json"
API_ROOT = "https://api.sunsang24.com/ship/schedule_fleet_list"
TIMEOUT_SECONDS = 20
MIN_REQUEST_GAP_SECONDS = 2.0
SPECIES_TERMS = ("쭈꾸미", "주꾸미", "갑오징어")
USER_AGENT = "FishingGajaScheduleCollector/1.0 (+https://github.com/JoonBiDDanG/fishing-scraper)"
KST = ZoneInfo("Asia/Seoul")


class CollectionError(RuntimeError):
    pass


class TheFishingPageParser(HTMLParser):
    """Read public species labels and date/count cells; ignore all names and contact data."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.fish_tags = []
        self.cells = []
        self._cell = None
        self._in_num = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set((attrs.get("class") or "").split())
        if tag == "span" and "re_fish_tag" in classes:
            self._fish_active = True
        if tag == "td":
            self._cell = {"attrs": attrs, "classes": classes, "count_text": "", "text": ""}
        if self._cell is not None and tag == "span" and "num" in classes:
            self._in_num += 1

    def handle_endtag(self, tag):
        if tag == "span" and getattr(self, "_fish_active", False):
            self._fish_active = False
        if tag == "span" and self._in_num:
            self._in_num -= 1
        if tag == "td" and self._cell is not None:
            self.cells.append(self._cell)
            self._cell = None

    def handle_data(self, data):
        if getattr(self, "_fish_active", False):
            value = data.strip()
            if value:
                self.fish_tags.append(value)
        if self._cell is not None:
            self._cell["text"] += data
            if self._in_num:
                self._cell["count_text"] += data


def parse_thefishing_calendar(html: str, month: str) -> list[dict]:
    parser = TheFishingPageParser()
    parser.feed(html)
    rows = []
    for cell in parser.cells:
        attrs_text = " ".join(str(v) for v in cell["attrs"].values())
        match = re.search(r"(?<!\\d)(20\\d{6})(?!\\d)", attrs_text)
        if not match:
            continue
        day = match.group(1)
        if day[:6] != month:
            continue
        classes = cell["classes"]
        count_match = re.search(r"\\d{1,3}", cell["count_text"])
        count = int(count_match.group()) if count_match else None
        if "wait_btn" in classes:
            status = "full"
        elif classes.intersection({"re_btn", "re_btn2"}) and count is not None and count > 0:
            status = "available"
        elif classes.intersection({"re_btn", "re_btn2"}) and count == 0:
            status = "full"
        else:
            continue
        rows.append({"date": f"{day[:4]}-{day[4:6]}-{day[6:]}", "remaining": count, "status": status})
    return rows


def thefishing_calendar_uid(html: str) -> str:
    # Accept only the numeric calendar UID exposed by the public bootstrap page.
    matches = set(re.findall(
        r"(?:st_uid|calendar_uid)\\s*(?:=|:)\\s*['\\\"]?(\\d{1,12})",
        html,
        flags=re.IGNORECASE,
    ))
    if len(matches) != 1:
        raise CollectionError("더피씽 공개 페이지에서 달력 식별자를 하나로 확인하지 못했습니다.")
    return next(iter(matches))



def load_registry() -> dict:
    value = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    if (value.get("schema_version") != 1 or not isinstance(value.get("sunsang24"), list)\n            or not isinstance(value.get("thefishing", []), list)):
        raise CollectionError("source_registry.json 형식이 올바르지 않습니다.")
    for fleet in value["sunsang24"]:
        if not re.fullmatch(r"[1-9][0-9]{0,11}", str(fleet.get("entry_id", ""))):
            raise CollectionError("등록되지 않은 선상24 진입 ID입니다.")
        if not re.fullmatch(r"[a-z0-9.-]+\.sunsang24\.com", fleet.get("host", "")):
            raise CollectionError("허용된 선상24 선사 호스트가 아닙니다.")
        booking_url_template = fleet.get("booking_url_template")
        if booking_url_template not in (
            None,
            "https://www.sunsang24.com/ship/schedule?ship_no={ship_id}",
        ):
            raise CollectionError("허용되지 않은 선상24 예약 페이지 주소입니다.")
        if not isinstance(fleet.get("ships"), dict) or not fleet["ships"]:
            raise CollectionError("선박 ID와 이름을 명시적으로 등록해야 합니다.")
        for ship_id, ship in fleet["ships"].items():
            if not re.fullmatch(r"[1-9][0-9]{0,11}", str(ship_id)) or not ship.get("name"):
                raise CollectionError("선박 ID 또는 이름이 올바르지 않습니다.")
    return value


def target_months(today: date) -> list[str]:
    first = today.replace(day=1)
    if first.month == 12:
        next_first = date(first.year + 1, 1, 1)
    else:
        next_first = date(first.year, first.month + 1, 1)
    return [first.strftime("%Y%m"), next_first.strftime("%Y%m")]


def schedule_rows(payload) -> list[dict]:
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        candidates = [payload[key] for key in ("list", "data", "items", "schedules")
                      if isinstance(payload.get(key), list)]
        if len(candidates) != 1:
            raise CollectionError("선상24 응답에 하나의 일정 목록이 없습니다.")
        rows = candidates[0]
    else:
        raise CollectionError("선상24 응답 형식을 확인할 수 없습니다.")
    if not rows:
        raise CollectionError("선상24가 빈 목록을 반환했습니다. 이전 저장본을 유지합니다.")
    if any(not isinstance(row, dict) for row in rows):
        raise CollectionError("선상24 응답에 해석할 수 없는 일정 항목이 있습니다.")
    return rows


def nonnegative_count(value):
    if type(value) is int and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"\d{1,6}", value.strip()):
        return int(value.strip())
    return None


def parse_remaining(row: dict, ship: dict, status: str):
    key = "remain_embarkation_num" if "remain_embarkation_num" in row else "remain"
    count = nonnegative_count(row.get(key))
    if "remain_embarkation_num" in row and "remain" in row:
        other = nonnegative_count(row.get("remain"))
        if count is None or other != count:
            return None
    if ship.get("is_reservation_count_view") != 1:
        return None
    if status == "available" or (status == "full" and count == 0):
        return count
    return None


def confirmed_status(row: dict) -> str:
    codes = {str(row[key]).strip().upper() for key in
             ("status_code", "schedule_status_code", "rstatus_code")
             if row.get(key) not in (None, "")}
    labels = {str(row[key]).strip() for key in
              ("status", "schedule_status_name", "status_name")
              if row.get(key) not in (None, "")}
    code = next(iter(codes)) if len(codes) == 1 else ""
    label = next(iter(labels)) if len(labels) == 1 else ""
    if code == "ING" and label == "예약가능" and row.get("is_schedule_oview") == 0:
        return "available"
    if code == "END" and label == "예약마감":
        return "full"
    if code in {"BAD_WEATHER", "CANCEL"} and "취소" in label:
        return "cancelled"
    if code == "CHECK" and ("점검일" in label or "휴무" in label):
        return "closed"
    if code == "CALL" and any(term in label for term in ("전화문의", "전화예약", "전화요망", "유선예약")):
        return "phone"
    return "unknown"


def collect():
    registry = load_registry()
    today = datetime.now(KST).date()
    months = target_months(today)
    session = requests.Session()
    session.headers.update({
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
        "Cache-Control": "no-cache",
    })
    result_rows = []
    last_request_at = 0.0
    request_count = 0

    for fleet in registry["sunsang24"]:
        host = fleet["host"]
        entry_id = str(fleet["entry_id"])
        expected_ships = fleet["ships"]
        for month in months:
            delay = MIN_REQUEST_GAP_SECONDS - (time.monotonic() - last_request_at)
            if delay > 0:
                time.sleep(delay)
            url = f"{API_ROOT}/{entry_id}/{month}"
            try:
                response = session.get(url, params={"simple": "", "possible": "", "eyyyymm": ""},
                                       timeout=TIMEOUT_SECONDS)
            except requests.RequestException as exc:
                raise CollectionError(f"{host} 일정 조회 연결 실패: {exc}") from exc
            last_request_at = time.monotonic()
            request_count += 1
            if response.status_code in (401, 403, 429, 503):
                raise CollectionError(f"{host} 요청이 차단 또는 제한되었습니다 (HTTP {response.status_code}). 중단합니다.")
            if not response.ok:
                raise CollectionError(f"{host} 응답 오류 (HTTP {response.status_code}).")
            content_type = response.headers.get("Content-Type", "").lower()
            if "json" not in content_type:
                raise CollectionError(f"{host}가 JSON 대신 다른 페이지를 반환했습니다. 우회하지 않고 중단합니다.")
            try:
                rows = schedule_rows(response.json())
            except (ValueError, requests.JSONDecodeError) as exc:
                raise CollectionError(f"{host} 응답 JSON을 읽지 못했습니다.") from exc

            month_seen = 0
            for row in rows:
                ship = row.get("ship")
                if not isinstance(ship, dict):
                    raise CollectionError(f"{host} 일정의 선박 식별 정보가 없습니다.")
                ship_id = str(ship.get("no", ""))
                source_name = str(ship.get("name", "")).strip()
                expected = expected_ships.get(ship_id)
                if expected is None:
                    print(
                        f"[{host}] 등록되지 않은 선박({ship_id}: {source_name}) 일정은 제외합니다.",
                        file=sys.stderr,
                    )
                    continue
                if source_name != expected["name"]:
                    raise CollectionError(
                        f"{host}의 등록 선박 ID {ship_id} 이름이 변경되었습니다 "
                        f"(등록: {expected['name']}, 응답: {source_name}). "
                        "source_registry.json 확인이 필요합니다."
                    )
                actual_date = str(row.get("sdate") or row.get("date") or "")
                try:
                    parsed_date = date.fromisoformat(actual_date)
                except ValueError as exc:
                    raise CollectionError(f"{host} 응답의 출조 날짜가 올바르지 않습니다.") from exc
                if parsed_date.strftime("%Y%m") != month:
                    raise CollectionError(f"{host}가 요청한 달과 다른 출조 날짜를 반환했습니다.")
                month_seen += 1

                if not re.fullmatch(r"[1-9][0-9]{0,15}", str(row.get("schedule_no", ""))):
                    continue
                fish = str(row.get("fish_type") or "").strip()
                if not fish or not any(term in fish for term in SPECIES_TERMS):
                    continue

                status = confirmed_status(row)
                remaining = parse_remaining(row, ship, status)
                departure = ""
                if ship.get("is_schedule_time_view") == 1:
                    start = row.get("stime")
                    if isinstance(start, str) and re.fullmatch(r"\d{2}:\d{2}:\d{2}", start):
                        departure = start[:5]

                booking_url_template = fleet.get("booking_url_template")
                if booking_url_template:
                    booking_url = booking_url_template.format(ship_id=ship_id)
                else:
                    booking_url = (
                        f"https://{host}/ship/schedule_fleet/{month}#d{actual_date}"
                    )
                result_rows.append({
                    "id": f"sunsang24:{ship_id}:{actual_date}:{row['schedule_no']}",
                    "provider": "sunsang24",
                    "platform": "선상24",
                    "boat": source_name,
                    "boatId": ship_id,
                    "speciesText": fish,
                    "date": actual_date,
                    "departure": departure,
                    "remaining": remaining,
                    "status": status,
                    "region": expected.get("region", "미분류"),
                    "port": expected.get("port", "미분류"),
                    "bookingUrl": booking_url,
                    "checkedAt": datetime.now(KST).isoformat(timespec="seconds"),
                })
            if month_seen == 0:
                raise CollectionError(f"{host} 응답에 {month} 일정의 선박 날짜가 없어 이전 저장본을 유지합니다.")


    for boat in registry.get("thefishing", []):
        if not re.fullmatch(r"[1-9][0-9]{0,11}", str(boat.get("uid", ""))):
            raise CollectionError("등록되지 않은 더피씽 공개 상품 ID입니다.")
        if not boat.get("name") or not boat.get("port"):
            raise CollectionError("더피씽 선박 이름과 항구를 등록해야 합니다.")

    for boat in registry.get("thefishing", []):
        uid = str(boat["uid"])
        page_url = f"https://thefishing.kr/reservation/list.php?uid={uid}"
        delay = MIN_REQUEST_GAP_SECONDS - (time.monotonic() - last_request_at)
        if delay > 0:
            time.sleep(delay)
        try:
            page = session.get(page_url, headers={"Accept": "text/html"}, timeout=TIMEOUT_SECONDS)
        except requests.RequestException as exc:
            raise CollectionError(f"더피씽 공개 일정 페이지 연결 실패: {exc}") from exc
        last_request_at = time.monotonic()
        request_count += 1
        if page.status_code in (401, 403, 429, 503):
            raise CollectionError(f"더피씽 요청이 제한되었습니다 (HTTP {page.status_code}). 중단합니다.")
        if not page.ok or "html" not in page.headers.get("Content-Type", "").lower():
            raise CollectionError(f"더피씽 공개 페이지가 HTML이 아닙니다 (HTTP {page.status_code}).")
        page_html = page.text
        bootstrap = TheFishingPageParser()
        bootstrap.feed(page_html)
        species = " · ".join(dict.fromkeys(bootstrap.fish_tags))
        if not any(term in species for term in SPECIES_TERMS):
            continue
        calendar_uid = thefishing_calendar_uid(page_html)
        for month in months:
            delay = MIN_REQUEST_GAP_SECONDS - (time.monotonic() - last_request_at)
            if delay > 0:
                time.sleep(delay)
            try:
                response = session.post(
                    "https://thefishing.kr/reservation/list.view.view.1.ajax.new.php",
                    data={"date6": month, "st_uid": calendar_uid, "pa_uid": uid},
                    headers={"Accept": "text/html", "Referer": page_url},
                    timeout=TIMEOUT_SECONDS,
                )
            except requests.RequestException as exc:
                raise CollectionError(f"더피씽 공개 달력 조회 실패: {exc}") from exc
            last_request_at = time.monotonic()
            request_count += 1
            if response.status_code in (401, 403, 429, 503):
                raise CollectionError(f"더피씽 달력 요청이 제한되었습니다 (HTTP {response.status_code}). 중단합니다.")
            if not response.ok or "html" not in response.headers.get("Content-Type", "").lower():
                raise CollectionError(f"더피씽 달력 응답이 HTML이 아닙니다 (HTTP {response.status_code}).")
            calendar_rows = parse_thefishing_calendar(response.text, month)
            for row in calendar_rows:
                result_rows.append({
                    "id": f"thefishing:{uid}:{row['date']}",
                    "provider": "thefishing",
                    "platform": "더피씽",
                    "boat": boat["name"],
                    "boatId": uid,
                    "speciesText": species,
                    "date": row["date"],
                    "departure": "",
                    "remaining": row["remaining"],
                    "status": row["status"],
                    "region": boat.get("region", "미분류"),
                    "port": boat["port"],
                    "bookingUrl": page_url,
                    "checkedAt": datetime.now(KST).isoformat(timespec="seconds"),
                })

    if not result_rows:
        raise CollectionError("쭈꾸미·갑오징어 일정이 확인되지 않아 이전 저장본을 유지합니다.")

    result_rows.sort(key=lambda row: (row["date"], row["region"], row["port"], row["boat"]))
    updated_at = datetime.now(KST).isoformat(timespec="seconds")
    output = {
        "schema_version": 1,
        "updated_at": updated_at,
        "source": "선상24·더피씽 공개 예약 달력",
        "request_count": request_count,
        "schedules": result_rows,
        "data": result_rows,
    }
    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"저장 완료: {len(result_rows)}건 / {request_count}회 조회 / {updated_at}")


if __name__ == "__main__":
    try:
        collect()
    except CollectionError as exc:
        print(f"수집 실패: {exc}", file=sys.stderr)
        raise SystemExit(1)
