import type { Candle, Chips } from "@/lib/data/types";
import { getTwTradingPhase, taipeiDayKey } from "@/lib/pollingSchedule";
import {
  MARGIN_BIG_CHANGE_PCT,
  MARGIN_MIN_CHANGE_LOTS,
  MARGIN_SIGNAL_PRICE_MOVE_PCT,
  MARGIN_SIGNAL_TEXT,
  MARGIN_SIGNAL_TITLE,
  SHORT_BIG_CHANGE_PCT,
  SHORT_MIN_CHANGE_LOTS,
  type MarginSignalCode,
} from "./marginSignalData";

/**
 * 融資融券組合判讀（純邏輯、無 I/O，有測試）——**唯一的來源函式**：個股資料、今日建議體檢、今日快報、
 * 回測都呼叫這裡，不各自重算（CLAUDE.md 功能互通原則）。
 *
 * 輸入全部來自既有快取（chips:TW:margin 的 marginBalance／marginBalanceChange／shortBalance／shortBalanceChange 與
 * 當日漲跌幅），不新增上游請求。單位：張。
 *
 * 判讀順序（先中先得，同一天只給一個結論）：
 *  - 漲（≥ +1%）＋融資大增（≥ +3% 且 ≥ 100 張）→ 追高風險
 *  - 漲＋融券增加（≥ +10% 且 ≥ 30 張）→ 可能軋空
 *  - 跌（≤ −1%）＋融資大減（≤ −3% 且 ≥ 100 張）→ 籌碼沉澱
 *  - 跌＋融券增加 → 空方佔優
 *  - 其餘 → 中性（不寫進給 AI 的參考資料）
 */

export interface MarginSignalInput {
  /** 當日漲跌幅（%）；null＝不明 */
  changePercent: number | null | undefined;
  /** 融資今日餘額／較前日增減（張） */
  marginBalance?: number | null;
  marginBalanceChange?: number | null;
  /** 融券今日餘額／較前日增減（張） */
  shortBalance?: number | null;
  shortBalanceChange?: number | null;
}

export interface MarginSignal {
  code: MarginSignalCode;
  /** 訊號名稱（中性時為「中性」） */
  label: string;
  /** 一句白話說明（中性時為空字串） */
  meaning: string;
  /** 帶數字的依據，例如「股價 +2.3%、融資 +5.1%（+1,200張）、融券 +12%（+40張）」 */
  numbers: string;
  /** 融資／融券單日增減百分比（相對前一日餘額）；前日餘額為 0 或資料缺 → null */
  marginChangePct: number | null;
  shortChangePct: number | null;
}

const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toLocaleString("en-US")}`;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** 單日增減百分比＝增減 ÷ 前一日餘額（今日餘額 − 增減）。前日餘額 ≤ 0（從零新增）算不出百分比 → null。 */
function changePct(balance: number | null | undefined, change: number | null | undefined): number | null {
  if (balance == null || change == null) return null;
  const prev = balance - change;
  return prev > 0 ? (change / prev) * 100 : null;
}

/**
 * 算融資融券組合判讀。價格漲跌幅或融資／融券兩項增減都缺時回 null（無法判讀，不是中性）；
 * 只缺一邊（例如沒有融券）時，用有的那邊判讀。
 */
export function computeMarginSignal(input: MarginSignalInput): MarginSignal | null {
  const price = input.changePercent;
  const hasMargin = input.marginBalance != null && input.marginBalanceChange != null;
  const hasShort = input.shortBalance != null && input.shortBalanceChange != null;
  if (price == null || !Number.isFinite(price) || (!hasMargin && !hasShort)) return null;

  const mPct = changePct(input.marginBalance, input.marginBalanceChange);
  const sPct = changePct(input.shortBalance, input.shortBalanceChange);
  const mChg = input.marginBalanceChange ?? 0;
  const sChg = input.shortBalanceChange ?? 0;

  const up = price >= MARGIN_SIGNAL_PRICE_MOVE_PCT;
  const down = price <= -MARGIN_SIGNAL_PRICE_MOVE_PCT;
  const marginBigUp = mPct != null && mPct >= MARGIN_BIG_CHANGE_PCT && mChg >= MARGIN_MIN_CHANGE_LOTS;
  const marginBigDown = mPct != null && mPct <= -MARGIN_BIG_CHANGE_PCT && mChg <= -MARGIN_MIN_CHANGE_LOTS;
  const shortUp = sPct != null && sPct >= SHORT_BIG_CHANGE_PCT && sChg >= SHORT_MIN_CHANGE_LOTS;

  const parts = [
    `股價${price >= 0 ? "+" : ""}${r1(price)}%`,
    hasMargin ? `融資${mPct != null ? `${mPct >= 0 ? "+" : ""}${r1(mPct)}%` : ""}（${signed(mChg)}張）` : "",
    hasShort ? `融券${sPct != null ? `${sPct >= 0 ? "+" : ""}${r1(sPct)}%` : ""}（${signed(sChg)}張）` : "",
  ].filter(Boolean);
  const numbers = parts.join("、");

  let code: MarginSignalCode = "neutral";
  if (up && marginBigUp) code = "chase";
  else if (up && shortUp) code = "squeeze";
  else if (down && marginBigDown) code = "settle";
  else if (down && shortUp) code = "bearish";

  if (code === "neutral") return { code, label: "中性", meaning: "", numbers, marginChangePct: mPct, shortChangePct: sPct };
  const t = MARGIN_SIGNAL_TEXT[code];
  return { code, label: t.label, meaning: t.meaning, numbers, marginChangePct: mPct, shortChangePct: sPct };
}

/**
 * 給 AI 的一行參考資料；中性或無法判讀回 null（只在有非中性訊號時組入，省 token）。
 * `scope` 是資料日期說明（例如「10/6 收盤」），讓模型知道這是單日、不是趨勢。
 */
export function describeMarginSignal(sig: MarginSignal | null, scope?: string): string | null {
  if (!sig || sig.code === "neutral") return null;
  return `${MARGIN_SIGNAL_TITLE}（程式依單日數字算好${scope ? `，${scope}` : ""}）：【${sig.label}】${sig.meaning}。依據：${sig.numbers}`;
}

/**
 * 融資融券報表（約 21 點後才公布）與報價的「交易日」要對得上，不然會拿「今天的漲跌」配「昨天的融資增減」。
 * 盤前／週末：報價是上一個交易日的收盤，融資融券也已是同一天（前一晚公布）→ 對得上；
 * 盤中／盤後定價／收盤後：報價是今天，融資融券要等於今天才算對得上（收盤後到 21 點之間會是昨天 → 對不上，先不判讀）。
 */
export function marginDataMatchesPrice(marginDate: string | undefined, now: Date = new Date()): boolean {
  if (!marginDate) return false;
  const phase = getTwTradingPhase(now);
  if (phase === "weekend" || phase === "pre-open") return true;
  return marginDate === taipeiDayKey(now);
}

/** 某個交易日的單日漲跌幅（%）＝當天收盤 ÷ 前一根收盤；日K沒有那天或前一根時回 null。 */
export function changePercentOnDate(candles: Candle[] | null | undefined, date: string | undefined): number | null {
  if (!candles || !date) return null;
  const i = candles.findIndex((c) => c.time.slice(0, 10) === date);
  if (i < 1 || candles[i - 1].close <= 0) return null;
  return (candles[i].close / candles[i - 1].close - 1) * 100;
}

/**
 * 從 Chips＋漲跌幅一步算出一行參考資料（個股資料、今日建議、今日快報共用）。
 * `changePercent`＝報價的當日漲跌幅；融資融券交易日跟報價對不上時改用 `candles` 算融資融券那天的漲跌幅，
 * 沒有日K就回 null（寧可不判讀，不拿錯天的數字配對）。
 */
export function marginSignalLine(
  chips: Chips | null | undefined,
  changePercent: number | null | undefined,
  opts: { now?: Date; candles?: Candle[] | null } = {}
): string | null {
  if (!chips || chips.marginBalance == null) return null;
  const aligned = marginDataMatchesPrice(chips.marginDate, opts.now);
  const pct = aligned ? changePercent : changePercentOnDate(opts.candles, chips.marginDate);
  const md = chips.marginDate ? `${chips.marginDate.slice(5).replace("-", "/")}單日` : "單日";
  return describeMarginSignal(
    computeMarginSignal({
      changePercent: pct,
      marginBalance: chips.marginBalance,
      marginBalanceChange: chips.marginBalanceChange,
      shortBalance: chips.shortBalance,
      shortBalanceChange: chips.shortBalanceChange,
    }),
    `${md}數字，不是趨勢`
  );
}

export const MARGIN_SIGNAL_APPENDIX_TITLE = "融資融券組合判讀（本站程式說明）";
/** 最多補幾檔（關注清單深度分析可能有十幾檔，全補會稀釋重點）。 */
export const MARGIN_SIGNAL_APPENDIX_MAX = 4;
const STOCK_HEADER = /^股票：(.+?)（([0-9A-Za-z.\-]+)，台股）/;
const SIGNAL_LINE = new RegExp(`^${MARGIN_SIGNAL_TITLE}（[^）]*）：【([^】]+)】(.*)$`);

/**
 * 回答後保證（唯一入口，ask.ts postProcessAiAnswer 呼叫；跨模型評測同一路徑）：
 * 個股參考資料有「融資融券組合判讀」【訊號】、回答提到該檔卻沒講出訊號名稱時，在回答最後補上程式寫好的一句
 * （確定性、不重生）。評測 2026-10-06：只靠提示詞規則，gemini-flash-lite／NVIDIA 在「融資融券怎麼看」「可以買嗎」常略過它。
 */
export function ensureMarginSignalMentioned(answer: string, grounding: string): { text: string; appended: string[] } {
  if (!answer || !grounding.includes(MARGIN_SIGNAL_TITLE)) return { text: answer, appended: [] };
  const missing: Array<{ symbol: string; line: string }> = [];
  let cur: { name: string; symbol: string } | null = null;
  for (const raw of grounding.split("\n")) {
    const h = raw.match(STOCK_HEADER);
    if (h) {
      cur = { name: h[1].replace(/[*＊]/g, "").trim(), symbol: h[2] };
      continue;
    }
    const m = cur ? raw.match(SIGNAL_LINE) : null;
    if (!cur || !m) continue;
    const [, label, rest] = m;
    const mentioned = answer.includes(cur.symbol) || (cur.name.length >= 2 && answer.includes(cur.name));
    if (mentioned && !answer.includes(label)) missing.push({ symbol: cur.symbol, line: `${cur.name}(${cur.symbol})：【${label}】${rest}` });
  }
  if (missing.length === 0) return { text: answer, appended: [] };
  const shown = missing.slice(0, MARGIN_SIGNAL_APPENDIX_MAX);
  return {
    text: `${answer.replace(/\s+$/, "")}\n\n${MARGIN_SIGNAL_APPENDIX_TITLE}：\n${shown.map((x) => `- ${x.line}`).join("\n")}`,
    appended: shown.map((x) => x.symbol),
  };
}
