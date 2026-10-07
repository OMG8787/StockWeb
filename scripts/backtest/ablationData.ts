/**
 * 消融實驗（2026-10-07）第一步：把每檔、每個交易日「評等用得到的原始成分」抽出來存檔，之後的消融與權重搜尋
 * 只在這份特徵上重組規則（快，可跑上千種組合），不用每次重算指標。
 *   npx tsx scripts/backtest/ablationData.ts is|oos
 *
 * 每一列都同時記錄正式評等核心 computeRatingCore()（現行：單日籌碼＋2日確認、ACTIVE_CHASE_GUARDS）的結論 code，
 * ablation.ts 會先用「重組出來的現行規則」逐列比對，必須 100% 相同才往下做（證明重組沒有偏離正式站）。
 * 無未來資料：技術訊號／價位框架／追高指標只用訊號日（含）以前的日K；法人與融資融券用當天盤後公布值；
 * 報酬＝隔日開盤進場、10／20 日後收盤。
 */
import type { Candle, Chips } from "@/lib/data/types";
import { computeRatingCore } from "@/lib/ai/ratingCore";
import type { ConfirmState } from "@/lib/ai/ratingStability";
import { ACTIVE_CHASE_GUARDS, ALL_CHASE_GUARDS, evaluateChaseGuards } from "@/lib/ai/chaseGuards";
import { sumChipsWindow, type ChipsDayRow } from "@/lib/ai/chipsWindow";
import fs from "node:fs";
import path from "node:path";
import { IS, OOS } from "./regimeConfig";
import { buildUniverseFor, loadCandlesFor } from "./regimeData";

export const ABLATION_OUT_DIR = path.join(path.dirname(IS.cacheDir), "ablation");

/** 技術訊號家族（label → 家族代碼）。順序固定，ablation.ts 用同一份。 */
export const FAMILIES = ["VOL", "HL", "MA20", "ALIGN", "STREAK", "RSI", "MACD", "KD", "BOLL"] as const;
export type Family = (typeof FAMILIES)[number];
export function familyOf(label: string): Family | null {
  if (label.startsWith("爆量") || label === "量縮") return "VOL";
  if (/新高|新低/.test(label)) return "HL";
  if (/20日均線/.test(label)) return "MA20";
  if (/排列/.test(label)) return "ALIGN";
  if (/^連[漲跌]/.test(label)) return "STREAK";
  if (label.startsWith("RSI")) return "RSI";
  if (label.startsWith("MACD")) return "MACD";
  if (label.startsWith("KD")) return "KD";
  if (label.includes("布林")) return "BOLL";
  return null;
}

/** 一列＝一檔一天。sig：每個訊號一個字串「家族:tone[:oh]」（oh＝漲多警訊）。 */
export interface FeatRow {
  s: string; // sym
  t: string; // tier
  d: string; // date
  code: "buy" | "avoid" | "buy-on-pullback"; // 正式核心（現行）結論
  sig: string[];
  inst: number | null; // 當日三大法人（股）
  fgn: number | null;
  w3: number | null; // 近 3／5／10 日三大法人累計
  w5: number | null;
  w10: number | null;
  vol20: number; // 前 20 日均量（股），標準化用
  broke: boolean; // 價位框架：跌破所有均線與近期低點
  noFw: boolean; // 沒有價位框架
  guards: string[]; // ALL_CHASE_GUARDS 中觸發者
  ret60: number | null; // 加權 60 日報酬
  mb: number | null; // 融資餘額、前日、限額（張）
  mbPrev: number | null;
  mLimit: number | null;
  r10: number | null;
  r20: number | null;
}

interface DayChips { date: string; inst: number; foreign: number; trust: number }

function main(which: "is" | "oos") {
  const p = which === "oos" ? OOS : IS;
  const { universe } = buildUniverseFor(p);
  const cal = loadCandlesFor(p, "2330")!.map((c) => c.time).filter((d) => d >= p.signalStart && d <= p.signalEnd);
  const twii = loadCandlesFor(p, "_TWII");
  const ret60 = new Map<string, number>();
  if (twii) twii.forEach((c, k) => k >= 60 && ret60.set(c.time, (c.close / twii[k - 60].close - 1) * 100));
  const rows: FeatRow[] = [];
  let used = 0;
  for (const u of universe) {
    const cs = loadCandlesFor(p, u.sym);
    const fn = path.join(p.cacheDir, "daily-chips", `${u.sym}.json`);
    if (!cs || !fs.existsSync(fn)) continue;
    const dc = (JSON.parse(fs.readFileSync(fn, "utf8")) as { rows: DayChips[] }).rows;
    if (!dc?.length) continue;
    const mfn = path.join(p.cacheDir, "daily-margin", `${u.sym}.json`);
    const mrows = fs.existsSync(mfn) ? (JSON.parse(fs.readFileSync(mfn, "utf8")) as { rows: { date: string; mb: number; mbPrev: number; mLimit: number }[] }).rows : [];
    const mByDate = new Map(mrows.map((r) => [r.date, r]));
    used++;
    const cIdx = new Map(cs.map((c, i) => [c.time, i]));
    const chipDates = dc.map((r) => r.date);
    const dayRows: ChipsDayRow[] = dc.map((r) => ({ date: r.date, foreign: r.foreign, trust: r.trust, dealer: r.inst - r.foreign - r.trust }));
    let j = -1;
    let state: ConfirmState | null = null;
    for (const date of cal) {
      const i = cIdx.get(date);
      if (i == null || i < 63 || !cs[i + 1] || cs[i].volume === 0) continue;
      while (j + 1 < chipDates.length && chipDates[j + 1] <= date) j++;
      const hasToday = j >= 0 && chipDates[j] === date;
      const hist = cs.slice(0, i + 1);
      const win = hist.slice(-63);
      const chips: Chips | null = hasToday
        ? { institutionalNetShares: dc[j].inst, foreignNetShares: dc[j].foreign, trustNetShares: dc[j].trust }
        : null;
      const core = computeRatingCore({
        symbol: u.sym, name: u.name, price: cs[i].close, market: "TW", candles: win, chaseCandles: hist, asOfDay: date, chips,
        guards: ACTIVE_CHASE_GUARDS, marketRet60Pct: ret60.get(date) ?? null, confirmPrev: state,
      });
      state = core.rating.confirmState ?? null;
      const hits = core.chase ? evaluateChaseGuards(core.chase, ALL_CHASE_GUARDS).map((h) => h.id) : [];
      const sw = (n: number) => (hasToday ? sumChipsWindow(dayRows.slice(0, j + 1), n)?.institutionalNetShares ?? null : null);
      const pv = hist.slice(-21, -1).map((c) => c.volume);
      const m = mByDate.get(date);
      const fwd = (h: number) => (cs[i + 1] && cs[i + h] ? (cs[i + h].close / cs[i + 1].open - 1) * 100 : null);
      rows.push({
        s: u.sym, t: u.tier, d: date, code: core.rating.code,
        sig: core.signals.map((x) => {
          const f = familyOf(x.label) ?? "OTHER";
          const oh = x.tone === "up" && /超買|布林通道上緣/.test(x.label);
          return `${f}:${x.tone}${oh ? ":oh" : ""}`;
        }),
        inst: chips?.institutionalNetShares ?? null, fgn: chips?.foreignNetShares ?? null,
        w3: sw(3), w5: sw(5), w10: sw(10),
        vol20: pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : 0,
        broke: !!core.framework && !core.framework.zone, noFw: !core.framework,
        guards: hits, ret60: ret60.get(date) ?? null,
        mb: m?.mb ?? null, mbPrev: m?.mbPrev ?? null, mLimit: m?.mLimit ?? null,
        r10: fwd(10), r20: fwd(20),
      });
    }
  }
  fs.mkdirSync(ABLATION_OUT_DIR, { recursive: true });
  const out = path.join(ABLATION_OUT_DIR, `feat-${which}.json`);
  fs.writeFileSync(out, JSON.stringify(rows));
  console.log(`${p.label}：${used} 檔、${rows.length} 列 → ${out}`);
}

if (process.argv[1]?.includes("ablationData")) {
  const w = process.argv[2];
  if (w === "is" || w === "both") main("is");
  if (w === "oos" || w === "both") main("oos");
}
