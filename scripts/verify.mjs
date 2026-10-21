#!/usr/bin/env node
/**
 * fishing_data.json 이 앱(FishingGajaScheduleApi.search)의 기대 형식과 맞는지 검증한다.
 * 실제 앱 코드의 org.json 접근 순서를 그대로 흉내 낸다.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

const file = process.argv[2] || "fishing_data.json";
const raw = await readFile(file, "utf8");
const root = JSON.parse(raw);
const rows = Array.isArray(root.schedules) ? root.schedules : Array.isArray(root.data) ? root.data : null;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

if (!rows) fail("schedules/data 배열이 없습니다");
if (!rows?.length) fail("일정이 0건입니다");

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const ids = new Set();
let nullSeats = 0;

for (const [i, r] of (rows ?? []).entries()) {
  if (typeof r.id !== "string" || !r.id.trim()) fail(`[${i}] id 없음`);
  if (ids.has(r.id)) fail(`[${i}] 중복 id ${r.id}`);
  ids.add(r.id);
  if (!dateRe.test(r.date ?? "")) fail(`[${i}] date 형식 오류: ${r.date}`);
  if (r.remaining !== null && !Number.isInteger(r.remaining)) fail(`[${i}] remaining 타입 오류`);
  if (r.remaining === null) nullSeats += 1;
  for (const key of ["boat", "region", "port", "speciesText"]) {
    if (typeof r[key] !== "string") fail(`[${i}] ${key} 타입 오류`);
  }
  if (r.departure !== null && !/^\d{2}:\d{2}$/.test(r.departure)) fail(`[${i}] departure 형식 오류: ${r.departure}`);
  if (r.latitude !== null && !Number.isFinite(r.latitude)) fail(`[${i}] latitude 오류`);
  if (r.longitude !== null && !Number.isFinite(r.longitude)) fail(`[${i}] longitude 오류`);
}

// 앱 검색 흉내: 날짜 + 지역 + 항구 + 어종 + 잔여석
const sampleDate = rows?.[0]?.date;
const sampleRegion = rows?.[0]?.region;
const samplePort = rows?.[0]?.port;
const byDate = (rows ?? []).filter((r) => r.date === sampleDate);
const byRegion = (rows ?? []).filter((r) => r.region === sampleRegion);
const byPort = (rows ?? []).filter((r) => r.port === samplePort);
const bySpecies = (rows ?? []).filter((r) => String(r.speciesText).includes("주꾸미"));
const bySeats = (rows ?? []).filter((r) => (r.remaining ?? 0) >= 3);

console.log(`OK  ${file}`);
console.log(`  rows       : ${rows?.length ?? 0}`);
console.log(`  updatedAt  : ${root.updatedAt ?? "-"}`);
console.log(`  range      : ${root.minDate ?? rows?.[0]?.date} ~ ${root.maxDate ?? rows?.at(-1)?.date}`);
console.log(`  seats null : ${nullSeats}`);
console.log(`  sample     : ${sampleDate} / ${sampleRegion} / ${samplePort}`);
console.log(`  filter date: ${byDate.length}`);
console.log(`  filter reg : ${byRegion.length}`);
console.log(`  filter port: ${byPort.length}`);
console.log(`  주꾸미      : ${bySpecies.length}`);
console.log(`  seats >= 3 : ${bySeats.length}`);
