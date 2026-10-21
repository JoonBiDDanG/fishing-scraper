#!/usr/bin/env node
/**
 * 선상24 + 더피싱 일정 스냅샷 생성기
 *
 * 앱(FishingGajaScheduleApi)이 읽는 fishing_data.json 을 만든다.
 * - 선상24: api.sunsang24.com 날짜별 일정 API
 * - 더피싱: thefishing.kr 선박별 월간 예약표(HTML)
 *
 * 원칙
 *  1) 수집이 실패한 날짜/선박은 기존 스냅샷 값을 유지한다.
 *  2) 전체가 실패하면 기존 파일을 절대 덮어쓰지 않는다.
 *  3) 앱이 읽는 필드만 남겨 용량을 줄인다.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { crawlSunsang } from "./sources/sunsang.mjs";
import { crawlThefishing, loadRegistry } from "./sources/thefishing.mjs";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "config.json");

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const warn = (...args) => console.warn(`[${new Date().toISOString()}]`, ...args);

function kstDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

function dateRange(fromIso, toIso) {
  const dates = [];
  for (let date = fromIso; date <= toIso; date = addDays(date, 1)) dates.push(date);
  return dates;
}

async function loadConfig() {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  return {
    daysAhead: Number.isFinite(cfg.daysAhead) ? cfg.daysAhead : 14,
    nearDays: Number.isFinite(cfg.nearDays) ? cfg.nearDays : 3,
    species: Array.isArray(cfg.species) && cfg.species.length ? cfg.species : ["주꾸미", "갑오징어"],
    outputFile: cfg.outputFile || "fishing_data.json",
    registryFile: cfg.registryFile || "data/thefishing-ships.json",
    concurrency: Number.isFinite(cfg.concurrency) ? cfg.concurrency : 8,
    sunsangThrottleMs: Number.isFinite(cfg.sunsangThrottleMs) ? cfg.sunsangThrottleMs : 3200,
    sources: { sunsang: true, thefishing: true, ...(cfg.sources ?? {}) },
  };
}

async function readExisting(file) {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    const rows = Array.isArray(data?.schedules) ? data.schedules : Array.isArray(data?.data) ? data.data : [];
    return rows.filter((row) => row && typeof row.id === "string" && typeof row.date === "string");
  } catch (error) {
    warn(`기존 스냅샷 읽기 실패: ${error.message}`);
    return [];
  }
}

function isValidRow(row) {
  return (
    row &&
    typeof row.id === "string" &&
    row.id &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.date ?? "") &&
    typeof row.boat === "string" &&
    typeof row.region === "string" &&
    typeof row.port === "string"
  );
}

function normalizeRow(row) {
  return {
    id: row.id,
    boat: row.boat ?? "",
    boatId: row.boatId ?? "",
    source: row.source ?? "",
    speciesText: row.speciesText ?? "",
    date: row.date,
    region: row.region ?? "",
    port: row.port ?? "",
    departure: row.departure ?? null,
    remaining: Number.isInteger(row.remaining) ? row.remaining : null,
    status: row.status ?? "unknown",
    url: row.url ?? "",
    checkedAt: row.checkedAt ?? new Date().toISOString(),
    latitude: Number.isFinite(row.latitude) ? row.latitude : null,
    longitude: Number.isFinite(row.longitude) ? row.longitude : null,
  };
}

function mergeRows(oldRows, newRows, coverage, today, lastDate) {
  const kept = [];
  for (const row of oldRows) {
    if (row.date < today || row.date > lastDate) continue;

    if (row.source === "선상24") {
      if (coverage.sunsang.has(row.date)) continue;
      kept.push(row);
      continue;
    }

    if (row.source === "더피싱") {
      const failedBoat = coverage.thefishingFailed.has(row.boatId);
      if (coverage.thefishing.has(row.date) && !failedBoat) continue;
      kept.push(row);
      continue;
    }

    kept.push(row);
  }

  const byId = new Map();
  for (const row of kept) byId.set(row.id, normalizeRow(row));
  for (const row of newRows) byId.set(row.id, normalizeRow(row));

  return [...byId.values()]
    .filter(isValidRow)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        String(a.departure ?? "99:99").localeCompare(String(b.departure ?? "99:99")) ||
        a.region.localeCompare(b.region, "ko") ||
        a.port.localeCompare(b.port, "ko") ||
        a.boat.localeCompare(b.boat, "ko"),
    );
}

async function main() {
  const cfg = await loadConfig();
  const outputPath = path.join(ROOT, cfg.outputFile);
  const previous = await readExisting(outputPath);

  const today = kstDate();
  const lastDate = addDays(today, cfg.daysAhead);
  const isFull =
    process.env.FULL_REFRESH === "1" ||
    process.env.FULL_REFRESH === "true" ||
    new Date().getUTCHours() === 18 ||
    previous.length === 0;

  const rangeEnd = isFull ? lastDate : addDays(today, Math.min(cfg.nearDays, cfg.daysAhead));
  const dates = dateRange(today, rangeEnd);

  log(
    `${isFull ? "전체" : "근거리"} 수집 · ${dates[0]} ~ ${dates.at(-1)} · ` +
      `어종 ${cfg.species.join("/")}`,
  );

  const runSunsang = cfg.sources.sunsang;
  const runThefishing =
    cfg.sources.thefishing && (isFull || new Date().getUTCHours() % 6 === 0);

  const emptyResult = { rows: [], covered: new Set(), failed: new Set() };

  const [sunsang, thefishing] = await Promise.all([
    runSunsang
      ? crawlSunsang(dates, cfg.species, {
          concurrency: cfg.concurrency,
          throttleMs: cfg.sunsangThrottleMs,
        }).catch((error) => {
          warn(`[선상24] 전체 실패: ${error.message}`);
          return emptyResult;
        })
      : Promise.resolve(emptyResult),
    runThefishing
      ? (async () => {
          try {
            const ships = await loadRegistry({
              file: path.join(ROOT, cfg.registryFile),
              configSpecies: cfg.species,
              concurrency: Math.min(5, cfg.concurrency),
              maxAgeDays: 3,
            });
            return await crawlThefishing(ships, dates, {
              configSpecies: cfg.species,
              concurrency: Math.min(6, cfg.concurrency),
            });
          } catch (error) {
            warn(`[더피싱] 전체 실패: ${error.message}`);
            return emptyResult;
          }
        })()
      : Promise.resolve(emptyResult),
  ]);

  log(`[선상24] ${sunsang.rows.length}건 · 커버 ${sunsang.covered.size}일`);
  log(
    `[더피싱] ${thefishing.rows.length}건 · 커버 ${thefishing.covered.size}일` +
      (thefishing.failed?.size ? ` · 실패 ${thefishing.failed.size}척` : ""),
  );

  const newRows = [...(sunsang.rows ?? []), ...(thefishing.rows ?? [])].filter(isValidRow);
  if (!newRows.length && previous.length) {
    log("새로 수집된 일정이 없습니다. 기존 스냅샷을 유지합니다.");
    return;
  }

  const coverage = {
    sunsang: sunsang.covered ?? new Set(),
    thefishing: thefishing.covered ?? new Set(),
    thefishingFailed: thefishing.failed ?? new Set(),
  };

  const merged = mergeRows(previous, newRows, coverage, today, lastDate);

  if (merged.length < 100) {
    warn(`수집 결과가 너무 적습니다 (${merged.length}건). 기존 파일을 유지합니다.`);
    process.exitCode = 2;
    return;
  }

  const snapshot = {
    updatedAt: new Date().toISOString(),
    minDate: merged[0].date,
    maxDate: merged[merged.length - 1].date,
    total: merged.length,
    schedules: merged,
  };

  const json = JSON.stringify(snapshot);
  const tmp = `${outputPath}.tmp`;
  await writeFile(tmp, json, "utf8");
  await rename(tmp, outputPath);

  const counts = merged.reduce((acc, row) => {
    acc[row.source] = (acc[row.source] ?? 0) + 1;
    return acc;
  }, {});

  log(
    `완료: ${cfg.outputFile} · ${snapshot.total}건 · ${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)}MB · ` +
      `${snapshot.minDate} ~ ${snapshot.maxDate} · ${JSON.stringify(counts)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
