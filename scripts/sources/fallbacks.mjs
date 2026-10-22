import { fetchJson } from "../lib/http.mjs";

const IPZIL_URL = "https://ipzil.com/api/data";
const NAKSIGO_URL = "https://naksigo.com/api/picks/find";

function asDate(value) {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function mapRow(row, source) {
  const date = asDate(row.date);
  const boat = String(row.boat ?? row.operator ?? "").trim();
  const id = String(row.id ?? "").trim();
  if (!date || !boat || !id) return null;
  const departure = String(row.departure ?? row.stime ?? "").match(/\d{1,2}:\d{2}/)?.[0] ?? null;
  return {
    id,
    boat,
    boatId: String(row.boatId ?? row.boat_id ?? ""),
    source,
    speciesText: String(row.speciesText ?? row.fish_type ?? row.species ?? row.main_species ?? "어종 확인 필요"),
    date,
    region: String(row.region ?? row.sido ?? ""),
    port: String(row.port ?? row.port_name ?? ""),
    departure,
    remaining: Number.isInteger(row.remaining) ? row.remaining : Number.isInteger(row.seats) ? row.seats : null,
    status: String(row.status ?? "unknown"),
    url: String(row.url ?? row.booking_url ?? ""),
    checkedAt: String(row.checkedAt ?? row.fetched_at ?? new Date().toISOString()),
    latitude: Number.isFinite(row.latitude) ? row.latitude : null,
    longitude: Number.isFinite(row.longitude) ? row.longitude : null,
    stale: Boolean(row.stale ?? row.fetchFailed),
  };
}

export async function crawlFallbacks(dates) {
  if (!dates.length) return [];
  const from = dates[0];
  const to = dates.at(-1);
  const ipzilUrl = new URL(IPZIL_URL);
  ipzilUrl.search = new URLSearchParams({ from, to, people: "1", status: "all" }).toString();
  const rows = [];
  const covered = { ipzil: new Set(), naksigo: new Set() };
  try {
    const body = await fetchJson(ipzilUrl.toString(), { timeoutMs: 45000, retries: 2 });
    const sourceRows = Array.isArray(body.schedules) ? body.schedules : Array.isArray(body.data) ? body.data : [];
    dates.forEach((date) => covered.ipzil.add(date));
    for (const row of sourceRows) {
      const mapped = mapRow(row, "입질닷컴");
      if (mapped && mapped.date >= from && mapped.date <= to) rows.push(mapped);
    }
    console.log(`[입질닷컴 보충] ${rows.length}건`);
  } catch (error) {
    console.warn(`[입질닷컴 보충] 실패: ${error.message}`);
  }

  // Naksigo exposes ranked day picks rather than a complete schedule table. Ask
  // once per date and keep only records that survive canonical deduplication.
  for (const date of dates) {
    const url = new URL(NAKSIGO_URL);
    url.search = new URLSearchParams({ people: "1", date }).toString();
    try {
      const body = await fetchJson(url.toString(), { timeoutMs: 30000, retries: 2 });
      covered.naksigo.add(date);
      const days = Array.isArray(body.days) ? body.days : [];
      for (const day of days) {
        const dayDate = asDate(day.date) || date;
        const items = Array.isArray(day.items) ? day.items : [];
        items.forEach((item, index) => {
          const boatId = item.boat_id ?? item.id;
          const mapped = mapRow({
            ...item,
            id: `ng:${boatId}:${dayDate}:${item.stime ?? ""}:${index}`,
            boatId: `ng-${boatId}`,
            date: dayDate,
            region: item.sido,
            port: item.port,
            url: item.booking_url,
            checkedAt: item.fetched_at,
          }, "낚시고");
          if (mapped) rows.push(mapped);
        });
      }
    } catch (error) {
      console.warn(`[낚시고 보충] ${date} 실패: ${error.message}`);
    }
  }
  return { rows, covered };
}

