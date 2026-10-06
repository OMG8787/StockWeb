import {
  getChips,
  getChipsRanking,
  getMultiSignalStocks,
  getValueScreen,
  getVolumeSurgeStocks,
  searchStocks,
} from "@/lib/data";
import { formatSharesWithLots, formatTurnover } from "@/lib/format";

// Momentum stocks get more slots than plain gainers: a gainer is just one
// number (today's %), but each momentum entry carries several independent,
// quantified technical readings (volume ratio, MA position, streak length,
// new high/low) that are worth surfacing in bulk so the model has enough
// material to explain *why* each one screens as technically strong, not
// just name it.
const GAINERS_N = 8;
const MOMENTUM_N = 12;
// 「技術訊號共振股」（getMultiSignalStocks）先天只從「當日漲跌幅最大的前15檔」
// 裡挑，所以像連漲多天但當天漲幅不是全市場數一數二的股票（例如漲停已經漲不動、
// 或漲幅普通但已經連漲好幾天）根本不會進到候選池——這正是使用者實測抓到的真實
// bug：問「價漲量增、連漲N天」的股票時被誤答「沒有資料」，但那些股票明明存在。
// getVolumeSurgeStocks 改成先掃全市場找出「今日價漲且量增」的股票（不受漲跌幅
// 排名限制），再算每一檔的連續上漲天數，補上這個原本抓不到的族群。
const VOLUME_SURGE_N = 30;

// 「成交金額最大」的排行要另外列，不能靠漲幅榜代打：使用者問「今天成交量最大的
// 是哪幾檔」時，原本資料裡根本沒有這份排行，AI 只好拿技術訊號共振股的法人買賣超
// 硬湊，答出來的東西跟「成交量最大」沒有關係。
const TURNOVER_N = 10;

export async function buildMoversGrounding(): Promise<string> {
  try {
    const [twGainers, usGainers, twMomentum, usMomentum, twVolumeSurge, twTurnover, twValueScreen, twChipsRanking] =
      await Promise.all([
        searchStocks({ market: "TW", sortBy: "changePercent", sortDir: "desc" }),
        searchStocks({ market: "US", sortBy: "changePercent", sortDir: "desc" }),
        getMultiSignalStocks("TW"),
        getMultiSignalStocks("US"),
        getVolumeSurgeStocks("TW").catch(() => []),
        searchStocks({ market: "TW", sortBy: "turnover", sortDir: "desc" }).catch(() => []),
        getValueScreen("TW").catch(() => null),
        getChipsRanking("TW").catch(() => null),
      ]);
    // TW momentum candidates also get their institutional flow attached —
    // without this, a "what else looks good" question could only be
    // answered with price/technical data, which reads as generic. Chip
    // data gives the model something concrete and stock-specific to cite
    // (e.g. "外資今天同步買超") beyond textbook sector commentary. US has
    // no equivalent public data source, so US entries are technical-only.
    const twMomentumSlice = twMomentum.slice(0, MOMENTUM_N);
    const twChips = await Promise.all(
      twMomentumSlice.map((s) => getChips(s.symbol, "TW").catch(() => null))
    );
    const fmtGainer = (items: typeof twGainers) =>
      items.slice(0, GAINERS_N).map((s) => `${s.name}(${s.symbol}) ${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%`).join("、") || "（無資料）";
    const fmtMomentum = (items: typeof twMomentum, chips?: (typeof twChips)[number][]) =>
      items
        .map((s, i) => {
          const chip = chips?.[i];
          const chipText = chip?.institutionalNetShares != null ? `；三大法人${formatSharesWithLots(chip.institutionalNetShares)}` : "";
          return `${s.name}(${s.symbol})，現價${s.price}(${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%)：${s.signals.map((sig) => sig.label).join("、")}${chipText}`;
        })
        .join("\n") || "（無資料）";
    const surgeSlice = twVolumeSurge.slice(0, VOLUME_SURGE_N);
    const fmtSurge = (items: typeof surgeSlice) =>
      items
        .map((s) => {
          const ratioText = s.volumeRatio != null ? `均量${s.volumeRatio.toFixed(1)}倍` : "";
          const streakText =
            s.streakDirection === "up" && s.streakDays >= 1
              ? `連漲${s.streakDays}天`
              : s.streakDirection === "down" && s.streakDays >= 1
                ? `今日雖上漲但近日走勢是連跌${s.streakDays}天後的反彈（尚未轉為連漲）`
                : "今日剛上漲，前一天走勢持平或方向不同（連漲天數算0，不成立連續）";
          return `${s.name}(${s.symbol})，現價${s.price}(+${s.changePercent}%)，${ratioText}，${streakText}`;
        })
        .join("\n") || "（今天沒有符合「價漲且量能明顯高於自身均量」條件的股票）";

    // 「連漲N天」的答案改成用程式先分好組，而不是讓 AI 自己從上面那份逐檔清單
    // 裡挑出符合天數的股票。2026-09-20 正式站實測：問「連漲6天呢」，清單裡其實
    // 沒有任何一檔剛好連漲 6 天（最接近的資通(2471)是連漲 7 天，程式算出來的真實
    // 數字），AI 卻回答「符合連漲6天的有：資通(2471)…連漲6天」——把使用者問的
    // 天數當成答案寫了出去，等於憑空捏造一個跟資料不符的數字。先用 prompt 規則
    // 要求「一定要寫出實際天數、差兩天就要老實說」試過一次，沒有用（AI 照樣寫
    // 6 天），所以改成結構性解法：直接把「哪些天數有、各有哪幾檔」算好給它，
    // 讓「有沒有剛好 N 天」變成查表，而不是需要 AI 自己逐檔比對的推理工作。
    const upStreaks = twVolumeSurge.filter((s) => s.streakDirection === "up" && s.streakDays >= 1);
    const streakDayList = [...new Set(upStreaks.map((s) => s.streakDays))].sort((a, b) => a - b);
    const streakIndex =
      upStreaks.length === 0
        ? "（今天這份清單裡沒有任何一檔是連續上漲的）"
        : [
            `清單裡實際出現過的連漲天數只有這幾種：${streakDayList.map((d) => `${d}天`).join("、")}。使用者問的天數如果不在這串數字裡，就是「今天沒有剛好連漲N天的股票」，要照實說，不可以把最接近的那檔說成符合N天。`,
            ...streakDayList.map(
              (d) =>
                `連漲${d}天（共${upStreaks.filter((s) => s.streakDays === d).length}檔）：${upStreaks
                  .filter((s) => s.streakDays === d)
                  .map((s) => `${s.name}(${s.symbol})`)
                  .join("、")}`
            ),
          ].join("\n");

    // 以下三組清單（成交金額榜、估值/跌幅篩選、法人買賣超排行）都是後來補的：
    // 實測發現使用者問「本益比低的股票」「殖利率高的股票」「今天跌最多的」
    // 「三大法人在買什麼」「外資買超最多的」「成交量最大的」這些非常自然的篩選
    // 問法時，AI 一律回答「資料裡沒有提供個股的本益比/殖利率數據」或拿漲幅榜硬湊
    // ——本站其實全都有全市場資料（見 getValueScreen/getChipsRanking 的註解），
    // 只是從來沒有整理成清單送進來，跟「價漲量增誤答沒有資料」是同一類問題。
    const fmtTurnover = (items: typeof twTurnover) =>
      items
        .slice(0, TURNOVER_N)
        .map((s) => `${s.name}(${s.symbol})，現價${s.price}(${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%)，成交金額約${formatTurnover(s.turnover, "TW")}`)
        .join("\n") || "（無資料）";
    const fmtValue = (items: NonNullable<typeof twValueScreen>["lowPe"], metric: "pe" | "yield" | "pb" | "change") =>
      items
        .map((s) => {
          const detail =
            metric === "pe"
              ? `本益比 ${s.peRatio}`
              : metric === "yield"
                ? `殖利率 ${s.dividendYield}%`
                : metric === "pb"
                  ? `股價淨值比 ${s.pbRatio}`
                  : `今日${s.changePercent}%`;
          const extras = [
            metric !== "pe" && s.peRatio != null ? `本益比 ${s.peRatio}` : "",
            metric !== "yield" && s.dividendYield != null ? `殖利率 ${s.dividendYield}%` : "",
            metric !== "pb" && s.pbRatio != null ? `股價淨值比 ${s.pbRatio}` : "",
          ].filter(Boolean);
          return `${s.name}(${s.symbol})，現價${s.price}(${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%)，${detail}${extras.length > 0 ? `；${extras.join("、")}` : ""}`;
        })
        .join("\n") || "（無資料）";
    const fmtChips = (items: NonNullable<typeof twChipsRanking>["institutionalBuy"]) =>
      items
        .map((s) => `${s.name}(${s.symbol})，現價${s.price}(${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%)，${formatSharesWithLots(s.netShares)}`)
        .join("\n") || "（無資料）";

    const valueBlocks = twValueScreen
      ? [
          `台股「本益比最低」排行（全市場掃描，只含今日成交金額 3000 萬元以上、真的有人在交易的股票，依本益比由低到高，共列 ${twValueScreen.lowPe.length} 檔。本益比低不等於便宜——景氣循環股在獲利高點時本益比天生就低，回答時要提醒這一點）：\n${fmtValue(twValueScreen.lowPe, "pe")}`,
          `台股「殖利率最高」排行（同上流動性條件，依殖利率由高到低，共列 ${twValueScreen.highYield.length} 檔。殖利率是用「過去已配發的現金股利 ÷ 現價」算的，不保證明年配一樣多）：\n${fmtValue(twValueScreen.highYield, "yield")}`,
          `台股「股價淨值比最低」排行（同上流動性條件，共列 ${twValueScreen.lowPb.length} 檔）：\n${fmtValue(twValueScreen.lowPb, "pb")}`,
          `台股今日跌幅榜（同上流動性條件，依今日跌幅由大到小，共列 ${twValueScreen.decliners.length} 檔。使用者問「跌最多的」「跌深反彈」「有沒有可以撿的」時就用這份清單，不要說沒有資料；但「跌得多」不等於「跌深了該撿」，要結合估值跟趨勢講清楚）：\n${fmtValue(twValueScreen.decliners, "change")}`,
        ]
      : [];
    const chipsBlocks = twChipsRanking
      ? [
          `台股今日「三大法人合計買超」排行前${twChipsRanking.institutionalBuy.length}（全市場，股數已換算好對應張數，直接引用不要自己重算）：\n${fmtChips(twChipsRanking.institutionalBuy)}`,
          `台股今日「三大法人合計賣超」排行前${twChipsRanking.institutionalSell.length}：\n${fmtChips(twChipsRanking.institutionalSell)}`,
          `台股今日「外資買超」排行前${twChipsRanking.foreignBuy.length}（只算外資這一家，跟上面的三大法人合計是不同數字，不要混用）：\n${fmtChips(twChipsRanking.foreignBuy)}`,
          `台股今日「外資賣超」排行前${twChipsRanking.foreignSell.length}：\n${fmtChips(twChipsRanking.foreignSell)}`,
          `台股今日「投信買超」排行前${twChipsRanking.trustBuy.length}：\n${fmtChips(twChipsRanking.trustBuy)}`,
        ]
      : [];

    return [
      `台股今日漲幅榜前${GAINERS_N}：${fmtGainer(twGainers)}`,
      `美股今日漲幅榜前${GAINERS_N}：${fmtGainer(usGainers)}`,
      `台股技術訊號共振股（同時符合≥2個客觀技術訊號，依訊號數量排序，共${twMomentum.length}檔，列出前${MOMENTUM_N}，含三大法人買賣超；股數已換算好對應張數，直接引用不要自己重算）：\n${fmtMomentum(twMomentumSlice, twChips)}`,
      `美股技術訊號共振股（共${usMomentum.length}檔，列出前${MOMENTUM_N}）：\n${fmtMomentum(usMomentum.slice(0, MOMENTUM_N))}`,
      `台股今日「價漲量增」股票（今日上漲、且成交量明顯高於自己近期均量，依成交金額排序，共${twVolumeSurge.length}檔，列出前${surgeSlice.length}，每檔都附上實際算出來的連續上漲天數——這是傳統技術分析的價量關係推論，不是真實委買賣單資料，見前述說明；使用者問「剛漲一天/連漲兩天/連漲三天...」這類指定天數的問題時，直接從這份清單裡依「連漲N天」精準篩選回答，天數是逐檔用近1個月K線實際比對算出來的真實數字，不是用今日漲跌%推測，不需要說「沒有資料」）：\n${fmtSurge(surgeSlice)}`,
      `台股「價漲量增」清單依連漲天數分組（這是上面那份清單用程式分好組的結果，不是另一份資料；使用者問「連漲N天的有哪些」時**一律直接查這張表**，不要自己去上面逐檔比對、也不要憑印象作答。表裡沒有列到的天數就是今天真的沒有，要照實說「今天沒有剛好連漲N天的」，然後可以順便告訴使用者有哪些天數，絕對不可以把別的天數的股票寫成符合使用者問的天數）：\n${streakIndex}`,
      `台股今日成交金額排行前${TURNOVER_N}（使用者問「今天成交量/成交金額最大的是哪幾檔」時用這份，不要拿漲幅榜或法人買超清單代替）：\n${fmtTurnover(twTurnover)}`,
      ...valueBlocks,
      ...chipsBlocks,
    ].join("\n\n");
  } catch {
    return "";
  }
}

/** 大盤題用的精簡漲跌榜區塊標題（askSystemCompose.ts 依這個標題決定帶 RULE_MARKET_PULSE）。 */
export const MARKET_PULSE_TITLE = "【今日漲跌榜（大盤題用的焦點，不是推薦名單）】";
const PULSE_N = 6;

/**
 * 「今天大盤怎樣／有什麼值得注意」這類全市場題用的精簡版漲跌榜（2026-10-06 評測：大盤題只拿到指數，
 * 答不出今天的焦點）。只列台股漲幅、跌幅、成交金額前幾名（上市櫃現有報價，不多打上游）；
 * 週末時資料是最近一個交易日，標籤由呼叫端傳入的 dayWord 決定。
 */
export async function buildMarketPulseGrounding(dayWord: string): Promise<string> {
  try {
    const [gainers, losers, turnover] = await Promise.all([
      searchStocks({ market: "TW", sortBy: "changePercent", sortDir: "desc" }),
      searchStocks({ market: "TW", sortBy: "changePercent", sortDir: "asc" }),
      searchStocks({ market: "TW", sortBy: "turnover", sortDir: "desc" }).catch(() => []),
    ]);
    const fmt = (items: typeof gainers) =>
      items
        .slice(0, PULSE_N)
        .map((s) => `${s.name.replace(/[*＊]/g, "")}(${s.symbol}) ${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%`)
        .join("、") || "（無資料）";
    const lines = [
      `台股${dayWord}漲幅前${PULSE_N}：${fmt(gainers)}`,
      `台股${dayWord}跌幅前${PULSE_N}：${fmt(losers)}`,
      turnover.length > 0 ? `台股${dayWord}成交金額前${PULSE_N}（資金最集中）：${fmt(turnover)}` : "",
    ].filter(Boolean);
    return `${MARKET_PULSE_TITLE}\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}
