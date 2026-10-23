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

const SPECIES_ALIASES = new Map([
  ["주꾸미", /주꾸미|쭈꾸미/], ["갑오징어", /갑오징어/], ["우럭", /우럭|조피볼락/],
  ["광어", /광어|넙치/], ["문어", /문어|돌문어/], ["갈치", /갈치/], ["참돔", /참돔/],
  ["백조기", /백조기|보구치/], ["농어", /농어/], ["방어", /방어/], ["부시리", /부시리/],
  ["오징어", /(?<!무늬)오징어|살오징어/], ["한치", /한치|창꼴뚜기/], ["열기", /열기|불볼락/],
  ["볼락", /볼락/], ["감성돔", /감성돔/], ["다잡아·생활낚시", /다잡아|생활낚시|종합낚시/],
  ["무늬오징어", /무늬오징어/], ["삼치", /삼치/], ["대구", /대구/], ["붉바리", /붉바리/],
  ["돌돔", /돌돔/], ["전갱이", /전갱이|아지/], ["민어", /민어/],
]);

export function detectSpecies(text, configSpecies) {
  const value = String(text ?? "").replace(/\s+/g, "");
  const found = new Set(configSpecies.filter((species) => SPECIES_ALIASES.get(species)?.test(value)));
  if (/쭈\s*[,/&·]?\s*갑|쭈갑/.test(value)) {
    found.add("주꾸미");
    found.add("갑오징어");
  }
  return configSpecies.filter((species) => found.has(species));
}

function registryPageUrl(page) {
  const params = new URLSearchParams([["sf[]", "1"], ["page", String(page)]]);
  return BASE + LIST_PATH + "?" + params.toString();
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
    if (!name || !/[가-힣A-Za-z0-9]/.test(name)) return;

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
  const firstHtml = await fetchText(registryPageUrl(1), { headers: HEADERS, timeoutMs: 30000 });
  const pageNumbers = [...firstHtml.matchAll(/list\.php\?[^"'#]*(?:&amp;|&|\?)page=(\d+)/g)].map((match) => Number(match[1]));
  const maxPage = Math.max(1, ...pageNumbers);

  const ships = new Map();
  parseListPage(firstHtml, configSpecies, ships);

  const pages = [];
  for (let page = 2; page <= maxPage; page += 1) pages.push(page);

  const bodies = await mapLimit(pages, concurrency, async (page) => {
    try {
      const html = await fetchText(registryPageUrl(page), {
        headers: HEADERS,
        timeoutMs: 30000,
        retries: 5,
      });
      return { page, html };
    } catch (error) {
      return { page, error };
    }
  });

  const failedPages = bodies.filter((result) => result.error);
  for (const result of bodies) {
    if (!result.error) parseListPage(result.html, configSpecies, ships);
  }
  if (failedPages.length) {
    console.warn(`[더피싱] ${failedPages.length}/${pages.length} 목록 페이지 실패: ${failedPages
      .slice(0, 8)
      .map((result) => result.page)
      .join(", ")}`);
  }

  const result = [...ships.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  result.partial = failedPages.length > 0;
  return result;
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

  let cached = null;
  if (existsSync(file)) {
    try {
      cached = JSON.parse(await readFile(file, "utf8"));
      const ageMs = Date.now() - Date.parse(cached.fetchedAt ?? 0);
      if (!force && Array.isArray(cached.ships) && cached.ships.length && ageMs < maxAgeDays * 86400000) {
        logger.log(`[더피싱] 저장된 선박 목록 사용 (${cached.ships.length}척)`);
        return cached.ships;
      }
    } catch {
      cached = null;
    }
  }

  logger.log("[더피싱] 선박 목록 수집");
  try {
    const crawled = await crawlRegistry(configSpecies, { concurrency });
    let ships = crawled;
    if (crawled.partial && Array.isArray(cached?.ships)) {
      const merged = new Map(cached.ships.map((ship) => [String(ship.uid), ship]));
      for (const ship of crawled) merged.set(String(ship.uid), ship);
      ships = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
      logger.warn(`[더피싱] 일부 페이지 누락으로 기존 선박 목록을 합쳐 ${ships.length}척을 유지합니다.`);
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ fetchedAt: new Date().toISOString(), ships }), "utf8");
    logger.log(`[더피싱] 선박 ${ships.length}척 저장`);
    return ships;
  } catch (error) {
    if (Array.isArray(cached?.ships) && cached.ships.length) {
      logger.warn(`[더피싱] 최신 목록 조회 실패, 저장된 목록 ${cached.ships.length}척으로 일정 조회를 계속합니다: ${error.message}`);
      return cached.ships;
    }
    throw error;
  }
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
    if (!soldOut && !bookable && remainText === undefined) continue;

    const status = soldOut ? "full" : bookable ? "available" : "unknown";
    const remaining = remainText !== undefined ? Number(remainText) : status === "full" ? 0 : null;

    const scheduleBlock = /<ul class="schedule2">([\s\S]*?)<\/ul>/i.exec(cell)?.[1] ?? "";
    const scheduleText = stripTags(scheduleBlock);
    const species = detectSpecies(scheduleText, configSpecies);
    const finalSpecies = species.length ? species : ship.species;
    const speciesText = finalSpecies.length ? finalSpecies.join(",") : scheduleText.trim() || ship.fishText || "어종 확인 필요";

    const bucket = byDate.get(date) ?? new Map();
    const slot = time ?? "";
    if (!bucket.has(slot)) {
      bucket.set(slot, {
        id: `tf:${ship.uid}:${compact}:${time ?? "x"}`,
        boat: ship.name,
        boatId: `tf-${ship.uid}`,
        source: "더피싱",
        speciesText,
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

