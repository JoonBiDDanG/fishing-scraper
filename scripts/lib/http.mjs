const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** AWS WAF 캡차/차단 응답. 재시도해도 의미가 없으므로 즉시 중단한다. */
export class WafBlockedError extends Error {
  constructor(url) {
    super(`WAF 차단됨: ${url}`);
    this.name = "WafBlockedError";
  }
}

export async function fetchText(url, options = {}) {
  const {
    method = "GET",
    body,
    headers = {},
    timeoutMs = 30000,
    retries = 3,
  } = options;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        body,
        redirect: "follow",
        signal: controller.signal,
        headers: { ...DEFAULT_HEADERS, ...headers },
      });
      const text = await response.text();
      const wafAction = response.headers.get("x-amzn-waf-action");
      if (wafAction || text.includes("Human Verification")) {
        throw new WafBlockedError(url);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${url} :: ${text.slice(0, 200)}`);
      }
      return text;
    } catch (error) {
      if (error instanceof WafBlockedError) throw error;
      lastError = error;
      if (attempt < retries) await sleep(600 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers ?? {}) },
  });
  return JSON.parse(text);
}

/** items 를 limit 개씩 동시에 처리한다. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function stripTags(value) {
  return decodeHtml(String(value ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
