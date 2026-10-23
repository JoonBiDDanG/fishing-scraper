import { fetchJson, mapLimit, sleep, WafBlockedError } from "../lib/http.mjs";

const LIST_URL = "https://api.sunsang24.com/ship/list";
const PAGE_SIZE = 30;

const HEADERS = {
  Origin: "https://www.sunsang24.com",
  Referer: "https://www.sunsang24.com/",
};

function hhmm(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? ""));
  if (!match) return null;
  const hour = Number(match[1]) % 24;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

export function mapStatus(name) {
  const text = String(name ?? "");
  if (text.includes("예약가능")) return "available";
  if (text.includes("예약마감")) return "full";
  if (text.includes("출항취소") || text.includes("취소")) return "cancelled";
  if (text.includes("휴항") || text.includes("조업")) return "closed";
  if (text.includes("전화")) return "available";
  return "unknown";
}

function toRow(item) {
  const ship = item?.ship ?? {};
  if (!ship.no || !item?.schedule_no || !item?.sdate) return null;

  // Request the unfiltered public list and preserve its actual species label.
  // Guessing a requested species here used to mislabel other trips.
  const speciesText = String(item.fish_type ?? "").trim() || "어종 확인 필요";

  return {
    id: `sa:${item.schedule_no}`,
    boat: String(ship.name ?? "").trim(),
    boatId: `sa-${ship.no}`,
    source: "선상24",
    speciesText,
    date: item.sdate,
    region: String(ship.area_main ?? "").trim(),
    port: String(item.port_name ?? ship.area_sub ?? "").trim(),
    departure: hhmm(item.stime),
    remaining: Number.isInteger(item.remain_embarkation_num)
      ? item.remain_embarkation_num
      : null,
    status: mapStatus(item.schedule_status_name),
    url: `https://www.sunsang24.com/ship/schedule?ship_no=${ship.no}`,
    checkedAt: new Date().toISOString(),
    latitude: Number.isFinite(ship.lat) ? ship.lat : null,
    longitude: Number.isFinite(ship.lng) ? ship.lng : null,
  };
}

// /ship/list 는 AWS WAF rate rule 이 걸려 있다. 요청 간격을 강제하고,
// 캡차가 뜨면 즉시 전체 수집을 멈춘다(다른 경로는 계속 사용 가능).
const state = { blocked: false, nextAt: 0, requests: 0, intervalMs: 3200 };

async function throttle() {
  if (state.blocked) throw new Error("WAF 차단으로 중단");
  const now = Date.now();
  const wait = Math.max(0, state.nextAt - now);
  state.nextAt = Math.max(now, state.nextAt) + state.intervalMs;
  if (wait > 0) await sleep(wait);
}

async function fetchPage(startDate, endDate, page) {
  await throttle();
  state.requests += 1;
  if (state.requests % 25 === 0) {
    console.log(`[선상24] 요청 ${state.requests}회 진행 중`);
  }

  const range = startDate === endDate ? startDate : `${startDate},${endDate}`;
  const url = `${LIST_URL}?type=general&sdate=${encodeURIComponent(range)}&page=${page}`;
  try {
    return await fetchJson(url, { headers: HEADERS, timeoutMs: 25000, retries: 2 });
  } catch (error) {
    if (error instanceof WafBlockedError) state.blocked = true;
    throw error;
  }
}

async function crawlRange(dates) {
  const wantedDates = new Set(dates);
  const startDate = dates[0];
  const endDate = dates.at(-1);
  const first = await fetchPage(startDate, endDate, 1);
  const total = Number(first?.total ?? 0);
  const firstList = Array.isArray(first?.list) ? first.list : [];
  if (!firstList.length) return [];

  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("선상24 응답에 전체 건수가 없어 페이지 범위를 확인할 수 없습니다.");
  }

  const items = [...firstList];
  const expectedPages = Math.ceil(total / PAGE_SIZE);
  for (let page = 2; page <= expectedPages; page += 1) {
    const body = await fetchPage(startDate, endDate, page);
    const rows = Array.isArray(body?.list) ? body.list : [];
    if (!rows.length || (rows.length < PAGE_SIZE && page < expectedPages)) {
      throw new Error(`페이지 ${page}/${expectedPages}에서 응답이 끊겨 전체 수집을 완료하지 못했습니다.`);
    }
    items.push(...rows);
  }

  const rows = [];
  for (const item of items) {
    if (!wantedDates.has(item?.sdate)) continue;
    const row = toRow(item);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * 날짜별 일정을 수집한다.
 * @returns {{rows: object[], covered: Set<string>}}
 */
export async function crawlSunsang(dates, speciesList, options = {}) {
  if (!dates.length) return { rows: [], covered: new Set() };

  // API는 날짜 구간 조회를 지원한다. 전체 날짜를 한 구간으로 페이지 처리해
  // 날짜별로 첫 페이지부터 반복 요청하던 중복 호출을 없앤다.
  state.blocked = false;
  state.nextAt = 0;
  state.requests = 0;
  state.intervalMs = options.throttleMs ?? 3200;

  try {
    const rows = await crawlRange(dates);
    return { rows, covered: new Set(dates) };
  } catch (error) {
    console.warn(`[선상24] ${dates[0]}~${dates.at(-1)} 실패: ${error.message}`);
    return { rows: [], covered: new Set(), failed: new Set(dates) };
  }
}
