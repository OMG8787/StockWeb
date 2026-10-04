import { fetchWithTimeout } from "./cache";

/**
 * FRED（美國聖路易聯準銀行）觀測值抓取——macro.ts（首頁總經卡片＋AI總經段）與
 * marketHistory.ts（VIX 近3個月序列）共用。獨立成檔是為了避免 macro.ts ↔
 * marketHistory.ts 互相 import 形成循環。
 */

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";

interface FredObservation {
  date: string;
  value: string;
}

export function isMacroConfigured(): boolean {
  return !!process.env.FRED_API_KEY;
}

export async function fetchObservations(seriesId: string, limit: number): Promise<Array<{ date: string; value: number }>> {
  const apiKey = process.env.FRED_API_KEY ?? "";
  // api_key 會被 fetchWithTimeout 的錯誤訊息遮罩（redactSecretParams 已涵蓋 api_key），
  // 不會外洩到 log 或畫面上。
  const url = `${FRED_BASE}?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(apiKey)}&file_type=json&sort_order=desc&limit=${limit}`;
  const res = await fetchWithTimeout(url, 6000);
  const data = (await res.json()) as { observations?: FredObservation[] };
  // FRED 用 "." 代表當天沒有資料（例如假日），要濾掉，不能當成 0。
  // 空字串也要擋（Number("") 會變成 0）。
  return (data.observations ?? [])
    .filter((o) => typeof o.value === "string" && o.value.trim() !== "" && o.value !== ".")
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .filter((o) => Number.isFinite(o.value) && /^\d{4}-\d{2}-\d{2}$/.test(o.date));
}

