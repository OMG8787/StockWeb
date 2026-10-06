/**
 * 「融資融券組合判讀」的純資料：門檻常數與四種訊號的白話文字（邏輯在 marginSignal.ts，規則九：資料與邏輯分離）。
 *
 * 2026-10-06 使用者待辦（10/4 記錄）：三個 AI 功能都拿得到融資／融券張數，但沒有「股價漲跌 × 融資增減 × 融券增減」
 * 的明確判讀，模型只給數字會漏判——比照「產業關鍵外部因子」：結論由程式先算好，AI 只負責解說。
 * 門檻是本站自訂的粗略分界、不是權威標準，事先寫死、不依回測結果調參（回測：docs/backtest/2026-10-margin-signal.md）。
 */

/** 股價單日漲跌幅（%）達這個絕對值才算「漲」或「跌」，小於視為持平（不判讀）。 */
export const MARGIN_SIGNAL_PRICE_MOVE_PCT = 1;
/** 融資餘額單日增減達這個百分比（相對前一日餘額）才算「大增／大減」。 */
export const MARGIN_BIG_CHANGE_PCT = 3;
/** 融資單日增減的絕對張數下限：餘額很小的股票 3% 只是幾十張，是雜訊。 */
export const MARGIN_MIN_CHANGE_LOTS = 100;
/** 融券餘額單日增加達這個百分比才算「融券增加」（融券基期小，波動大，門檻比融資高）。 */
export const SHORT_BIG_CHANGE_PCT = 10;
/** 融券單日增減的絕對張數下限。 */
export const SHORT_MIN_CHANGE_LOTS = 30;

/**
 * 附在每則判讀後面的誠實註記（2026-10-06 回測，docs/backtest/2026-10-margin-signal.md）：四種訊號後續 10～20 日的超額報酬
 * 在樣本內（2024-10～2026-08）與樣本外（2022-01～2024-09）方向不一致（例如「追高風險」樣本內 +0.87%、樣本外 -0.34%）、
 * 多數不顯著，所以不計入評等，也要避免 AI 把它講成「一定會回檔／一定會軋空」。
 */
export const MARGIN_SIGNAL_BACKTEST_NOTE = "本站回測：這類訊號後續10～20日的漲跌方向不一致、多不顯著，只當解釋籌碼的線索，不代表一定回檔或上漲";

export type MarginSignalCode = "chase" | "squeeze" | "settle" | "bearish" | "neutral";

/** 區塊標題：askSystemCompose.ts 依這個標題判斷要不要帶 RULE_MARGIN_SIGNAL，兩邊共用同一個常數。 */
export const MARGIN_SIGNAL_TITLE = "融資融券組合判讀";

export const MARGIN_SIGNAL_TEXT: Record<Exclude<MarginSignalCode, "neutral">, { label: string; meaning: string }> = {
  chase: {
    label: "追高風險",
    meaning: "股價上漲、融資同步大增：散戶可能借錢追高，籌碼偏浮動，短線追高被套的風險較大",
  },
  squeeze: {
    label: "可能軋空",
    meaning: "股價上漲、融券同步增加：看空的人加碼卻被拉抬，若續漲，空單被迫回補（軋空）可能再推升股價；但也代表看空者仍多、波動會變大",
  },
  settle: {
    label: "籌碼沉澱",
    meaning: "股價下跌、融資大減：散戶停損或斷頭出場、浮額被清掉，籌碼趨於沉澱，通常是賣壓逐步釋放的跡象（不代表馬上止跌）",
  },
  bearish: {
    label: "空方佔優",
    meaning: "股價下跌、融券增加：放空的人加碼、股價順勢走弱，空方暫時佔優",
  },
};
