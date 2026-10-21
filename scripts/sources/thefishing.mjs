import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fetchText, mapLimit, stripTags } from "../lib/http.mjs";

const BASE = "https://thefishing.kr";
const LIST_PATH = "/reservation/list.php";
const AJAX_PATH = "/reservation/list.view.view.1.ajax.new.php";

const HEADERS = {
  Referer: `${BASE}${LIST_PATH}`,
};

const REGION_MAP = {
  서울특별시: "서울",
  부산광역시: "부산",
  대구광역시: "대구",
  인천광역시: "인천",
  광주광역시: "광주",
  대전광역시: "대전",
  울산광역시: "울산",
  세종특별자치시: "세종",
  경기도: "경기",
  강원도: "강원",
  강원특별자치도: "강원",
  충청북도: "충북",
  충청남도: "충남",
  전라북도: "전북",
  전북특별자치도: "전북",
  전라남도: "전남",
  경상북도: "경북",
  경상남도: "경남",
  제주특별자치도: "제주",
  제주도: "제주",
};

function parseArea(pathText) {
  const tokens = String(pathText ?? "")
    .split(">")
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !/^(서해권|남해권|동해권|제주권)$/.test(token));

  let region = "";
  for (const token of tokens) {
    if (REGION_MAP[token]) {
      region = REGION_MAP[token];
      break;
    }
    if (/도$/.test(token)) {
      region = token.replace(/특별자치도$|특별도$|도$/, "");
      break;
    }
  }

  const port = tokens.at(-1) ?? "";
  const district = tokens.length >= 2 ? tokens[tokens.length - 2] : "";
  return { region, port, district: /(시|군|구)$/.test(district) ? district : "" };
}

export function detectSpecies(text, configSpecies) {
  const value = String(text ?? "");
  const found = new Set();
  if (/주꾸미|쭈꾸미/.test(value)) found.add("주꾸미");
  if (/갑오징어/.test(value)) found.add("갑오징어");
  if (/쭈\s*[,/&·]?\s*갑|쭈갑/.test(value)) {
    found.add("주꾸미");
    found.add("갑오징어");
  }
  return configSpecies.filter((species) => found.has(species));
}

function parseListPage(html, configSpecies, ships) {
  const matches = [...html.matchAll(/<li>\s*<a href="https:\/\/thefishing\.kr\/reservation\/list\.php\?uid=(\d+)"/g)];
  matches.forEach((match, index) => {
    const start = match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : Math.min(html.length, start + 6000);
    const block = html.slice(start, end);

    const uid = match[1];
    const name = stripTags(/class="re_list_ship">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "");
    const fishText = stripTags(/class="re_list_fish">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "");
    const areaText = stripTags(/class="re_list_area">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "");
    const capacityText = stripTags(/class="re_list_price">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "");

    const species = detectSpecies(fishText, configSpecies);
    if (!name || !/[가-힣A-Za-z0-9]/.test(name) || !species.length) return;

    const area = parseArea(areaText);
    const capacity = /(\d+)\s*인승/.exec(capacityText)?.[1];

    ships.set(uid, {
      uid,
      name,
      fishText,
      species,
      region: area.region,
      port: area.port,
      district: area.district,
      capacity: capacity ? Number(capacity) : null,
    });
  });
}

export async function crawlRegistry(configSpecies, options = {}) {
  const concurrency = options.concurrency ?? 5;
  const firstHtml = await fetchText(`${BASE}${LIST_PATH}?page=1`, { headers: HEADERS, timeoutMs: 30000 });
  const maxPage = Math.min(
    60,
    Math.max(1, ...([...firstHtml.matchAll(/list\.php\?page=(\d+)/g)].map((m) => Number(m[1])))),
  );

  const ships = new Map();
  parseListPage(firstHtml, configSpecies, ships);

  const pages = [];
  for (let page = 2; page <= maxPage; page += 1) pages.push(page);

  const bodies = await mapLimit(pages, concurrency, (page) =>
    fetchText(`${BASE}${LIST_PATH}?page=${page}`, { headers: HEADERS, timeoutMs: 30000 }),
  );
  for (const html of bodies) parseListPage(html, configSpecies, ships);

  return [...ships.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

export async function loadRegistry(options) {
  const {
    file,
    maxAgeDays = 7,
    force = false,
    configSpecies,
    concurrency = 5,
    logger = console,
  } = options;

  if (!force && existsSync(file)) {
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      const ageMs = Date.now() - Date.parse(saved.fetchedAt ?? 0);
      if (Array.isArray(saved.ships) && saved.ships.length && ageMs < maxAgeDays * 86400000) {
        logger.log(`[더피싱] 저장된 선박 목록 사용 (${saved.ships.length}척)`);
        return saved.ships;
      }
    } catch {
      // 손상된 캐시는 다시 만든다.
    }
  }

  logger.log("[더피싱] 선박 목록 수집");
  const ships = await crawlRegistry(configSpecies, { concurrency });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ fetchedAt: new Date().toISOString(), ships }), "utf8");
  logger.log(`[더피싱] 선박 ${ships.length}척 저장`);
  return ships;
}

function monthOf(dateString) {
  return dateString.slice(0, 7).replace("-", "");
}

async function fetchMonth(uid, stUid, month, headers) {
  const body = new URLSearchParams({ date6: month, st_uid: stUid, pa_uid: String(uid) }).toString();
  return fetchText(`${BASE}${AJAX_PATH}`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: BASE,
    },
    body,
    timeoutMs: 30000,
    retries: 3,
  });
}

function parseCalendar(html, ship, wantedDates, configSpecies) {
  // 날짜별로 모은 뒤, 같은 날짜에 시간이 있는 일정이 있으면 시간 없는 중복(모바일 달력)은 버린다.
  const byDate = new Map();
  const cells = html.split(/<td[^>]*>/i).slice(1);

  for (const raw of cells) {
    const cell = raw.split(/<\/td>/i)[0];
    const dateMatch = /date=(\d{8})/.exec(cell);
    if (!dateMatch) continue;

    const compact = dateMatch[1];
    const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    if (!wantedDates.has(date)) continue;

    const time = /(\d{2}:\d{2})\s*출항/.exec(cell)?.[1] ?? null;
    const remainText = /남은인원\s*<span class="num">\s*(\d+)\s*<\/span>/.exec(cell)?.[1];
    const soldOut = cell.includes("예약완료");
    const bookable = cell.includes("예약하기");
    const phoneInquiry = /전화\s*(?:문의|예약|요망)|유선\s*예약/i.test(stripTags(cell));
    if (!soldOut && !bookable && !phoneInquiry && remainText === undefined) continue;

    const status = soldOut ? "full" : phoneInquiry ? "phone" : bookable ? "available" : "unknown";
    const remaining = phoneInquiry ? null : remainText !== undefined ? Number(remainText) : status === "full" ? 0 : null;

    const scheduleBlock = /<ul class="schedule2">([\s\S]*?)<\/ul>/i.exec(cell)?.[1] ?? "";
    const scheduleText = stripTags(scheduleBlock);
    const species = detectSpecies(scheduleText, configSpecies);
    const finalSpecies = species.length ? species : ship.species;
    if (!finalSpecies.length) continue;

    const bucket = byDate.get(date) ?? new Map();
    const slot = time ?? "";
    if (!bucket.has(slot)) {
      bucket.set(slot, {
        id: `tf:${ship.uid}:${compact}:${time ?? "x"}`,
        boat: ship.name,
        boatId: `tf-${ship.uid}`,
        source: "더피싱",
        speciesText: finalSpecies.join(","),
        date,
        region: ship.region,
        port: ship.port,
        departure: time,
        remaining,
        status,
        url: `${BASE}${LIST_PATH}?uid=${ship.uid}`,
        checkedAt: new Date().toISOString(),
        latitude: null,
        longitude: null,
      });
    }
    if (time) bucket.delete("");
    byDate.set(date, bucket);
  }

  const rows = [];
  for (const bucket of byDate.values()) {
    for (const [slot, row] of bucket) {
      if (slot === "" && bucket.size > 1) continue;
      rows.push(row);
    }
  }
  return rows;
}

async function crawlShip(ship, dates, options) {
  const { configSpecies, concurrency } = options;
  const pageUrl = `${BASE}${LIST_PATH}?uid=${ship.uid}`;
  const html = await fetchText(pageUrl, { headers: HEADERS, timeoutMs: 30000 });

  const stUid = /st_uid=(\d+)/.exec(html)?.[1];
  if (!stUid) throw new Error(`st_uid 없음 (uid=${ship.uid})`);

  const activeMonth =
    /type1_ajax\('(\d{6})'\);\s*"\s*class="on"/.exec(html)?.[1] ?? monthOf(dates[0]);
  const wantedDates = new Set(dates);
  const months = [...new Set(dates.map(monthOf))];

  const rows = [];
  for (const month of months) {
    const body = month === activeMonth ? html : await fetchMonth(ship.uid, stUid, month, HEADERS);
    rows.push(...parseCalendar(body, ship, wantedDates, configSpecies));
  }
  return rows;
}

/**
 * 더피싱 선박별 일정을 수집한다.
 * @returns {{rows: object[], failed: Set<string>, covered: Set<string>}}
 */
export async function crawlThefishing(ships, dates, options = {}) {
  const concurrency = options.concurrency ?? 6;
  const rows = [];
  const failed = new Set();

  await mapLimit(ships, concurrency, async (ship) => {
    try {
      const shipRows = await crawlShip(ship, dates, options);
      rows.push(...shipRows);
    } catch (error) {
      failed.add(ship.boatId ?? `tf-${ship.uid}`);
      if (failed.size <= 5) console.warn(`[더피싱] ${ship.name} 실패: ${error.message}`);
    }
  });

  const covered = failed.size > ships.length * 0.5 ? new Set() : new Set(dates);
  return { rows, failed, covered };
}
