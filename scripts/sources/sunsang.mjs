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
  if (text.includes("전화")) return "phone";
  if (text.includes("예약가능")) return "available";
  if (text.includes("예약마감")) return "full";
  if (text.includes("출항취소") || text.includes("취소")) return "cancelled";
  if (text.includes("휴항") || text.includes("조업")) return "closed";
  return "unknown";
}

function toRow(item, wantedSpecies) {
  const ship = item?.ship ?? {};
  if (!ship.no || !item?.schedule_no || !item?.sdate) return null;

  const rawSpecies = String(item.fish_type ?? "");
  const matched = wantedSpecies.filter((species) => rawSpecies.includes(species));
  const speciesText = matched.length ? matched.join(",") : wantedSpecies[0] ?? "";

  const status = mapStatus(item.schedule_status_name);

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
    remaining: status === "phone"
      ? null
      : Number.isInteger(item.remain_embarkation_num)
        ? item.remain_embarkation_num
        : null,
    status,
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

async function fetchPage(date, species, page) {
  await throttle();
  state.requests += 1;
  if (state.requests % 25 === 0) {
    console.log(`[선상24] 요청 ${state.requests}회 진행 중`);
  }

  const url =
    `${LIST_URL}?type=general&sdate=${encodeURIComponent(date)}` +
    `&page=${page}&fish=${encodeURIComponent(species)}`;
  try {
    return await fetchJson(url, { headers: HEADERS, timeoutMs: 25000, retries: 2 });
  } catch (error) {
    if (error instanceof WafBlockedError) state.blocked = true;
    throw error;
  }
}

async function crawlOne(date, species, concurrency) {
  const first = await fetchPage(date, species, 1);
  const total = Number(first?.total ?? 0);
  const firstList = Array.isArray(first?.list) ? first.list : [];
  if (!firstList.length) return [];

  let pageCount = total > 0 ? Math.ceil(total / PAGE_SIZE) : firstList.length >= PAGE_SIZE ? 40 : 1;
  pageCount = Math.min(pageCount, 200);

  const pages = [];
  for (let page = 2; page <= pageCount; page += 1) pages.push(page);

  const rest = await mapLimit(pages, concurrency, (page) => fetchPage(date, species, page));
  const items = [...firstList, ...rest.flatMap((body) => (Array.isArray(body?.list) ? body.list : []))];

  const rows = [];
  for (const item of items) {
    const row = toRow(item, [species]);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * 날짜별 일정을 수집한다.
 * @returns {{rows: object[], covered: Set<string>}}
 */
export async function crawlSunsang(dates, speciesList, options = {}) {
  const concurrency = options.concurrency ?? 8;
  const species = speciesList.length ? speciesList : ["주꾸미"];

  const tasks = [];
  for (const date of dates) for (const name of species) tasks.push({ date, name });

  state.blocked = false;
  state.nextAt = 0;
  state.requests = 0;
  state.intervalMs = options.throttleMs ?? 3200;

  // WAF 회피를 위해 날짜·어종 작업을 직렬로 처리한다.
  const results = await mapLimit(tasks, 1, async (task) => {
    try {
      const rows = await crawlOne(task.date, task.name, 1);
      return { ...task, rows };
    } catch (error) {
      return { ...task, error };
    }
  });

  const merged = new Map();
  const byDate = new Map();
  for (const result of results) {
    if (result.error) {
      console.warn(`[선상24] ${result.date} ${result.name} 실패: ${result.error.message}`);
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
    if (!byDate.has(result.date)) byDate.set(result.date, new Set());
    byDate.get(result.date).add(result.name);
  }

  const rows = [...merged.values()];

  // 모든 어종 쿼리가 성공한 날짜만 "교체 완료"로 본다.
  const covered = new Set();
  for (const [date, names] of byDate) {
    if (species.every((name) => names.has(name))) covered.add(date);
  }

  return { rows, covered };
}
