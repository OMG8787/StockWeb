import type { Market } from "@/lib/data";
import { getQuote } from "@/lib/data";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import {
  computeSaleMetrics,
  isSaleConfirmed,
  mayHaveRatingLog,
  pickRatingAtSale,
  ratingWindowFor,
  SALE_VERDICT_LABEL,
  visibleSales,
  type RatingAtSaleEntry,
  type SaleRecord,
} from "@/lib/soldRecords";
import { readRatingLog } from "../ratingLog";
import type { HoldingInput } from "../askTypes";

/**
 * 關注清單「已賣出」區塊（2026-10-06）：讓 AI 能檢討「賣得對不對」。
 * 數字（已實現損益、賣出後漲跌、若沒賣差額、賣出當天本站建議）全部由程式用 lib/soldRecords.ts
 * ——也就是畫面「已賣出」表格同一組函式——算好，AI 只負責解說，不可自己重算。
 * 這只是資料區塊，不影響任何評等邏輯。
 */

export interface SoldLineInput {
  name: string;
  symbol: string;
  market: Market;
  /** 現價；抓不到＝null */
  price: number | null;
  rec: SaleRecord;
  rating: Pick<RatingAtSaleEntry, "day" | "label" | "holdingLabel"> | null;
}

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n: number, d = 0) => `${n >= 0 ? "+" : ""}${fmt(n, d)}`;

/** 一筆賣出紀錄 → 一行文字（純函式，有測試）。 */
export function formatSoldLine(i: SoldLineInput, today: string): string {
  const { rec } = i;
  const m = computeSaleMetrics(rec, i.price, i.market, today);
  const confirmed = isSaleConfirmed(rec);
  const kind = rec.remaining > 0 ? `部分賣出（賣出後仍持有 ${rec.remaining} 股）` : "全部賣出";
  const flag = confirmed ? "使用者已確認" : "（估計值，未確認：賣出價為記錄當下現價估計，尚未確認實際成交價）";
  const head = `${i.name}(${i.symbol}) ${rec.date} 賣出 ${fmt(rec.shares, 2).replace(/\.00$/, "")} 股，${kind}；買進價 ${rec.buyPrice ?? "未記錄"}、賣出價 ${rec.sellPrice ?? "未填"}，${flag}`;
  const parts: string[] = [];
  if (m.realizedPnl != null) {
    parts.push(`已實現損益 ${signed(m.realizedPnl)}${m.realizedPct != null ? `（${signed(m.realizedPct, 1)}%）` : ""}（${i.market === "TW" ? "已估算扣除手續費與證交稅" : "美股不計手續費"}）`);
  }
  if (m.afterSellPct != null && m.verdict) {
    parts.push(
      `賣出後 ${m.days ?? "?"} 天，現價 ${i.price}，賣出後漲跌 ${signed(m.afterSellPct, 2)}%＝${SALE_VERDICT_LABEL[m.verdict]}（漲＝賣早了、跌＝賣對了）；若沒賣價差 ${signed(m.heldDiff ?? 0)}（純價差）`
    );
    if (m.ifHeldPnl != null) parts.push(`若一直沒賣、現在以現價賣出損益 ${signed(m.ifHeldPnl)}${m.ifHeldPct != null ? `（${signed(m.ifHeldPct, 1)}%）` : ""}`);
  } else {
    parts.push("缺賣出價或現價，算不出賣出後漲跌");
  }
  parts.push(
    i.rating
      ? `賣出當天本站建議：「${i.rating.holdingLabel}」${i.rating.day !== rec.date ? `（取 ${i.rating.day} 的紀錄）` : ""}`
      : "賣出當天本站建議：無紀錄"
  );
  return `- ${head}；${parts.join("；")}`;
}

/** 彙總（只算已確認的；未確認的估計值另外數）。 */
export function summarizeSoldLines(lines: SoldLineInput[], today: string): string {
  let right = 0;
  let early = 0;
  let confirmed = 0;
  let unconfirmed = 0;
  for (const l of lines) {
    if (!isSaleConfirmed(l.rec)) {
      unconfirmed++;
      continue;
    }
    confirmed++;
    const v = computeSaleMetrics(l.rec, l.price, l.market, today).verdict;
    if (v === "right") right++;
    else if (v === "early") early++;
  }
  const base = confirmed > 0 ? `已確認 ${confirmed} 筆中：賣對了 ${right} 筆、賣早了 ${early} 筆` : "尚無使用者已確認的賣出紀錄，不下賣得對不對的統計結論";
  return unconfirmed > 0 ? `${base}；另有 ${unconfirmed} 筆是估計值、尚未確認（不納入統計，個別提到時要註明「估計值，未確認」）` : base;
}

export const SOLD_BLOCK_INTRO =
  "【已賣出紀錄（使用者過去賣出的紀錄，用來檢討賣得對不對；以下數字已由程式算好，請直接引用、不要自己重算；這不是對這些股票現在的買賣建議）】";

/** 這份關注清單裡有賣出紀錄的所有股票 → 已賣出區塊文字；沒有紀錄回空字串。 */
export async function buildSoldGrounding(holdings: HoldingInput[]): Promise<string> {
  const withSales = holdings.map((h) => ({ h, sales: visibleSales(h) })).filter((x) => x.sales.length > 0);
  if (withSales.length === 0) return "";
  const today = taipeiDayKey();

  // 現價（同一檔只查一次）與賣出當天評等（每個賣出日一個查詢窗口）。
  const priceBySymbol = new Map<string, number | null>();
  await Promise.all(
    withSales.map(async ({ h }) => {
      const q = await getQuote(h.symbol, h.market).catch(() => null);
      priceBySymbol.set(`${h.market}:${h.symbol}`, q?.price ?? null);
    })
  );
  const dates = Array.from(new Set(withSales.flatMap((x) => x.sales.map((s) => s.date)))).filter(mayHaveRatingLog);
  const entries: RatingAtSaleEntry[] = [];
  await Promise.all(
    dates.slice(0, 15).map(async (date) => {
      const { from, to } = ratingWindowFor(date);
      const wanted = new Set(withSales.map((x) => x.h.symbol.toUpperCase()));
      const got = await readRatingLog(from, to).catch(() => []);
      for (const e of got) if (wanted.has(e.symbol.toUpperCase())) entries.push(e);
    })
  );

  const lines: SoldLineInput[] = withSales.flatMap(({ h, sales }) =>
    sales.map((rec) => ({
      name: h.name,
      symbol: h.symbol,
      market: h.market,
      price: priceBySymbol.get(`${h.market}:${h.symbol}`) ?? null,
      rec,
      rating: pickRatingAtSale(entries, h.symbol, rec.date),
    }))
  );
  lines.sort((a, b) => (a.rec.date < b.rec.date ? 1 : a.rec.date > b.rec.date ? -1 : 0));
  return [SOLD_BLOCK_INTRO, ...lines.map((l) => formatSoldLine(l, today)), summarizeSoldLines(lines, today)].join("\n");
}
