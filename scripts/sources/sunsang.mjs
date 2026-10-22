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

async function fetchPage(date, page) {
  await throttle();
  state.requests += 1;
  if (state.requests % 25 === 0) {
    console.log(`[선상24] 요청 ${state.requests}회 진행 중`);
  }

  const url = `${LIST_URL}?type=general&sdate=${encodeURIComponent(date)}&page=${page}`;
  try {
    return await fetchJson(url, { headers: HEADERS, timeoutMs: 25000, retries: 2 });
  } catch (error) {
    if (error instanceof WafBlockedError) state.blocked = true;
    throw error;
  }
}

async function crawlOne(date, concurrency) {
  const first = await fetchPage(date, 1);
  const total = Number(first?.total ?? 0);
  const firstList = Array.isArray(first?.list) ? first.list : [];
  if (!firstList.length) return [];

  // Do not silently truncate at an arbitrary number of pages. The API's total is
  // authoritative; if it is absent, continue until the provider returns a short page.
  const items = [...firstList];
  let page = 2;
  const expectedPages = total > 0 ? Math.ceil(total / PAGE_SIZE) : Number.POSITIVE_INFINITY;
  while (page <= expectedPages && page <= 1000) {
    const body = await fetchPage(date, page);
    const rows = Array.isArray(body?.list) ? body.list : [];
    items.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    page += 1;
  }

  const rows = [];
  for (const item of items) {
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
  // Requests are deliberately serial: this public API actively rate-limits bursts.
  const tasks = dates.map((date) => ({ date }));

  state.blocked = false;
  state.nextAt = 0;
  state.requests = 0;
  state.intervalMs = options.throttleMs ?? 3200;

  // WAF 회피를 위해 날짜 및 페이지 작업을 직렬로 처리한다.
  const results = await mapLimit(tasks, 1, async (task) => {
    try {
      const rows = await crawlOne(task.date, 1);
      return { ...task, rows };
    } catch (error) {
      return { ...task, error };
    }
  });

  const merged = new Map();
  const byDate = new Map();
  for (const result of results) {
    if (result.error) {
      console.warn(`[선상24] ${result.date} 실패: ${result.error.message}`);
      continue;
    }
    for (const row of result.rows) {
      const previous = merged.get(row.id);
      if (!previous) {
        merged.set(row.id, row);
      } else {
        const species = new Set(
          [...previous.speciesText.split(","), ...row.speciesText.split(",")].filter(Boolean),
        );
        previous.speciesText = [...species].join(",");
      }
    }
    byDate.set(result.date, true);
  }

  const rows = [...merged.values()];

  const covered = new Set([...byDate.keys()]);

  return { rows, covered };
}

