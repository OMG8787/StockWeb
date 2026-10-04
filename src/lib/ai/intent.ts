import type { Market } from "@/lib/data";
import type { ChatTurn } from "@/lib/ai/types";
import { guessSymbolsFromText } from "./symbolResolve";

// Matches "有哪些股票不錯"/"什麼股票要漲了"/"推薦一下"/"今天有什麼強勢股" style
// questions that aren't about any one stock — asking for a list, not a lookup.
// Without this, guessSymbolFromText finds nothing, no grounding is attached,
// and the model (correctly, per its instructions not to invent numbers) just
// says it has no data — even though the site already computes exactly this
// kind of thing (焦點排行/技術訊號共振) for the /highlights page.
//
// A real conversation caught this pattern missing common multi-turn follow-
// up phrasings — "還有別的比較有機率漲幅較大的嗎？" matched none of the
// original phrases (no "有哪些"/"推薦"/"強勢股" etc.), so buildMoversGrounding
// never ran and the model, with no fresh screened candidates to work from,
// fell back to generic textbook answers ("留意 AI 伺服器供應鏈如鴻海、廣達")
// instead of naming anything from the site's own data. Broadened to also
// catch "還有別的/其他"-style follow-ups and generic buy-idea phrasing —
// safe to widen, since this only fires when guessSymbolFromText found no
// specific stock in the question at all (see wantsMovers below).
// 2026-09-15 使用者實測發現：問「現在有價漲量增，但還沒連漲，還來得及明天買的
// 股票嗎？」這種完整的篩選問法，原本的關鍵字清單完全沒有一個對得上（沒有「有
// 哪些／推薦／強勢股」這類字眼），導致 wantsMovers 判定為 false、完全沒有附上
// 任何篩選資料，AI 在真的沒拿到資料的情況下如實回答「沒有資料」——這句話本身
// 沒有說謊，但問題出在關鍵字覆蓋率不夠廣，很多常見的篩選問法都漏接。這裡大幅
// 擴充關鍵字，涵蓋「價漲量增」「爆量」「連漲」「來得及」「值得買/適合買」等
// 常見的真實篩選用語。
const MOVERS_INTENT_PATTERN =
  /有哪些|哪幾檔|哪支|哪些股票|推薦|不錯的股票|強勢股|熱門股|飆股|焦點股|上漲的股票|要漲|要噴|準備上漲|還有.{0,3}(別的|其他)|有沒有.{0,3}(別的|其他)|有機會|機率.{0,6}(大|高)|買(什麼|甚麼)|選股|有推薦|價漲量增|价涨量增|價跌量增|量增|爆量|連漲|连涨|連跌|来得及|來得及|適合買|适合买|值得買|值得买|明天買|明天买|買點|买点|進場時機|进场时机|可以買嗎|可以买吗|該買|该买/;

// 上面那組關鍵字仍然接不住「連漲2天可以的話呢」之後的追問（例如「5天呢」「3天
// 呢」這種極短的接續句，本身不含任何關鍵字）——這種句子單獨看毫無線索，但放進
// 對話脈絡裡，使用者顯然是在追問同一個篩選條件的不同天數。這裡不試圖窮舉更多
// 關鍵字（治標不治本），而是直接看：如果這句很短、像是接續問法（含「呢/嗎/的
// 話/怎樣」等語氣詞或單純數字），且之前的對話裡使用者確實問過一次符合上面關鍵
// 字的篩選問題，就視為同一串追問，繼續套用篩選資料。
const BARE_FOLLOWUP_PATTERN = /^[\d一二三四五六七八九十]{0,4}\s*(天|日)?\s*(呢|嗎|吗|的話|的话|怎樣|怎样|可以嗎|可以吗)?[?？!！。.]?$/;

// BARE_FOLLOWUP_PATTERN 只接得住「3天呢?」這種幾乎只剩數字的句子。2026-09-16
// 實測發現同一類問題還有一個更常見的形狀沒接到：「那美股呢?」——上一句問
// 「今天台股有哪些股票不錯?」，接著問「那美股呢?」，這句既不含任何篩選關鍵字、
// 也不是純數字，於是 wantsMovers 判成 false，連美股漲幅榜都沒附上，AI 只能拿
// 大盤指數跟新聞回答，完全沒點名任何一檔美股個股——明明資料裡有美股漲幅榜跟
// 美股技術訊號共振股。這裡用「很短 + 以語氣詞結尾」這個形狀來涵蓋這一整類
// 接續句（那美股呢／台股呢／其他的呢／現在如何），不再靠窮舉關鍵字。
const SHORT_FOLLOWUP_MAX_LEN = 12;
function isShortFollowup(question: string): boolean {
  const trimmed = question.trim().replace(/[?？!！。.,，]+$/g, "");
  if (trimmed.length === 0 || trimmed.length > SHORT_FOLLOWUP_MAX_LEN) return false;
  return /(呢|咧|如何|怎樣|怎麼樣|怎么样|的話|的话)$/.test(trimmed);
}

function isFollowupShape(question: string): boolean {
  return BARE_FOLLOWUP_PATTERN.test(question.trim()) || isShortFollowup(question);
}

// 2026-09-20 正式站實測抓到的漏接：同一段對話裡問「殖利率高的股票有哪些」AI
// 正確列出了殖利率排行，但問「有沒有本益比低的股票」卻回答「參考資料裡沒有提供
// 本益比最低排行」——兩份排行明明是同一個資料區塊（buildMoversGrounding 裡的
// valueBlocks）一起送進來的。差別只在意圖判斷：「有哪些」在
// MOVERS_INTENT_PATTERN 裡，「有沒有…的股票」不在，所以後者根本沒有附上任何
// 篩選資料，AI 如實回答「沒有資料」。
//
// 修法比照 conversationWantsTechScreen 的結構：「提到某個排行用的指標」＋「這句
// 話是在找/篩股票」兩個條件同時成立才算，而不是看到「本益比」就觸發——「本益比
// 是什麼意思」這種名詞解釋不該被塞一整份全市場排行，而「台積電的本益比多少」
// 走的是個股資料那條路（這兩個 pattern 只有在問句沒指到任何特定股票時才會被
// 檢查，見 answerQuestion 裡的 targets.length === 0 前提）。
const RANKING_METRIC_PATTERN =
  /本益比|本益比|PE\s*ratio|殖利率|配息|股利|股價淨值比|股价净值比|淨值比|净值比|成交金額|成交金额|成交量|周轉|周转|跌幅|跌最多|跌得最多|跌深|漲幅|涨幅|法人|外資|外资|投信|自營|自营|買超|买超|賣超|卖超|融資|融资|融券/i;

// 2026-09-30 使用者反映：問「建議買什麼」這類開放式問題，AI 越來越常只從『我的關注清單』
// 挑股票回答，範圍太小。兩個原因疊加：①「建議買甚麼／有什麼可以布局」這類說法沒被
// MOVERS_INTENT_PATTERN 接住，wantsMovers 為 false，當下唯一有逐檔明細的就只剩
// 關注清單，模型自然只用它；②系統提示詞一直帶著『逐檔講重點』的關注清單規則。
// 這裡補上開放式買進建議的意圖判斷（給 wantsMovers 與『全市場推薦』提示詞規則共用），
// 並用 EXPLICIT_HOLDINGS_SCOPE_PATTERN 分辨使用者是不是明講只想看自己的清單。
const BUY_IDEA_INTENT_PATTERN =
  /建議.{0,8}(買|布局|佈局|進場|入手|投資|加碼)|(買|布局|佈局|進場|入手|投資).{0,4}(哪|什麼|甚麼|啥|哪些|哪一)|有什麼.{0,8}(可以|適合|值得).{0,4}(買|布局|佈局|進場|入手)|可以(買|布局|佈局|進場).{0,3}(什麼|甚麼|哪)|(挑|選).{0,3}(幾|一|兩|二|三)(檔|支)/;
const EXPLICIT_HOLDINGS_SCOPE_PATTERN = /(我的|我).{0,3}(關注|自選|持股|持有|庫存)|關注清單|自選股|持股裡|手上(的|有)/;

/** 這句（或上一句使用者的話）是不是在談自己的持股／關注清單／成本損益。
 *  沒有的話，關注清單只當背景名單附上，不附逐檔報價損益（見 ask.ts holdingsForGrounding）。 */
export const HOLDINGS_TOPIC_PATTERN =
  /(我的|我).{0,3}(關注|自選|持股|持有|庫存|部位)|關注清單|自選股|持股|持有|庫存|手上|成本|損益|賺|賠|虧|停損|止損|停利|止盈|續抱|加碼|減碼|該賣|要賣|賣掉|攤平|套牢|解套/;

/** 開放式『建議買什麼』且沒有明講只限自己清單 → 範圍是整個市場，不是關注清單。 */
export function wantsMarketWideBuyIdea(question: string): boolean {
  return BUY_IDEA_INTENT_PATTERN.test(question) && !EXPLICIT_HOLDINGS_SCOPE_PATTERN.test(question);
}

export function conversationWantsMovers(question: string, history: ChatTurn[]): boolean {
  // 用 wantsMarketWideBuyIdea（不是裸的 BUY_IDEA_INTENT_PATTERN）：「我的關注清單裡建議買哪檔」
  // 這種明講限定範圍的問法如果也附上全市場焦點資料，模型會先列出清單外的股票再自己改口
  // （2026-09-30 Opus 正式站複查實測抓到）。
  if (MOVERS_INTENT_PATTERN.test(question) || wantsMarketWideBuyIdea(question)) return true;
  if (RANKING_METRIC_PATTERN.test(question) && TECH_SCREEN_VERB_PATTERN.test(question)) return true;
  if (!isFollowupShape(question)) return false;
  return history.some(
    (turn) =>
      turn.role === "user" &&
      (MOVERS_INTENT_PATTERN.test(turn.content) ||
        (RANKING_METRIC_PATTERN.test(turn.content) && TECH_SCREEN_VERB_PATTERN.test(turn.content)))
  );
}

// 「用技術指標篩股票」的問法。拆成「有提到技術指標」＋「這句話是在找/篩股票」
// 兩個條件同時成立才算，而不是看到 KD/MACD/均線就觸發——「MACD是什麼意思」
// 「什麼是黃金交叉」這種純名詞解釋不需要（也不該）附上整份全市場篩選清單。
// 這兩個 pattern 只有在問句完全沒有指到任何特定股票時才會被檢查（見
// answerQuestion 裡的 targets.length === 0 前提），所以「台積電的KD如何」
// 走的是個股資料那條路，不受影響。
export const TECH_INDICATOR_PATTERN =
  /黃金交叉|黄金交叉|golden\s*cross|金叉|死亡交叉|死叉|多頭排列|多头排列|空頭排列|空头排列|超賣|超卖|超買|超买|技術指標|技术指标|技術面|技术面|KD|MACD|RSI|布林|K值|D值|均線|均线|乖離|乖离/i;
const TECH_SCREEN_VERB_PATTERN =
  /有沒有|有没有|有哪些|哪些|哪幾|哪几|哪支|哪一?檔|哪一?只|找出|找到|篩選|筛选|挑出|選股|选股|推薦|推荐|符合|同時|同时|都在|都已|條件|条件|股票|標的|标的/;

export function conversationWantsTechScreen(question: string, history: ChatTurn[]): boolean {
  if (TECH_INDICATOR_PATTERN.test(question) && TECH_SCREEN_VERB_PATTERN.test(question)) return true;
  // 極短的接續追問（「那KD呢」「其他呢」）本身不成句，靠對話脈絡判斷——
  // 跟 conversationWantsMovers 完全同一套邏輯，理由見那裡的註解。
  if (!isFollowupShape(question)) return false;
  return history.some(
    (turn) =>
      turn.role === "user" && TECH_INDICATOR_PATTERN.test(turn.content) && TECH_SCREEN_VERB_PATTERN.test(turn.content)
  );
}

// 使用者用「這檔/那支/它/第一檔/剛剛那個」指代上文提過的股票，或乾脆只丟一個
// 指標名稱（「本益比多少?」）繼續追問，而沒有再講一次股票名稱。
//
// 2026-09-16 實測抓到的真實錯答：對話裡 AI 已經講過「今天台股漲幅榜前幾名有
// 光鼎(6226)、雍智科技(6683)」，使用者接著問「第一檔的本益比多少?」，AI 回
// 「目前查不到這檔股票的本益比資料」——但 6226 的本益比本站其實查得到，只是
// 這一句沒寫出股票名稱，guessSymbolsFromText 自然什麼都找不到，完全沒有個股
// 資料可用。這個錯答比單純答不出來更糟：使用者會以為本站根本沒有這檔的資料。
const PRONOUN_FOLLOWUP_PATTERN =
  /這[檔支家隻個]|这[档支家只个]|那[檔支家隻]|第[一二三四五六七八九十\d]+[檔支個家只]|剛剛|刚刚|剛才|刚才|上面(那|提到|講|说|說)|前面(那|提到|講|说|說)/;
// 只丟指標名稱的追問（「本益比多少?」「法人買超多少?」）。因為沒有代名詞可以
// 當依據，條件收得比上面嚴格：句子要很短，而且不能含任何「這是在篩全市場」
// 的字眼，避免把「有沒有本益比低的股票」這種全市場篩選問題誤判成在問某一檔。
const METRIC_FOLLOWUP_PATTERN =
  /本益比|殖利率|股價淨值比|淨值比|市值|營收|营收|EPS|財報|财报|法人|籌碼|筹码|融資|融券|技術面|技术面|基本面|新聞|新闻|消息|現價|现价|股價|股价|漲跌|涨跌|成交量|均線|均线|RSI|MACD|KD|布林/i;
const METRIC_FOLLOWUP_MAX_LEN = 14;
// 2026-10-04 使用者反映「AI 順著對話聊著聊著就忘了前文」。實例：「還是是昨天有，所以
// 盤中你才說有？」「那你現在查看看」這種句子沒有代名詞、沒有指標名稱，原本兩條規則
// 都接不住，resolveFollowupTargets 回空陣列→這輪完全沒有個股資料，AI 只能憑對話紀錄
// 的文字瞎接。這裡補第三類：很短、而且是「核對／追問時間／質疑前後說法」的接續句。
const VERIFY_OR_TIME_FOLLOWUP_PATTERN =
  /查看|查一下|查查|再查|重新查|重查|確認|核對|檢查|再看|重新算|昨天|昨日|前天|前一天|上週|上周|早上|今早|稍早|剛才|剛剛|之前|先前|還是|所以|為什麼|為何|怎麼會|真的嗎|確定嗎|矛盾|不一樣|前後/;
const VERIFY_OR_TIME_FOLLOWUP_MAX_LEN = 24;
const SCREENING_WORDS_PATTERN = /有沒有|有没有|有哪些|哪些|哪幾|哪几|哪支|推薦|推荐|篩選|筛选|選股|选股|排行|最高|最低|前幾名|前几名/;

function parseOrdinal(question: string): number | null {
  const digit = question.match(/第(\d+)[檔支個家只]/);
  if (digit) return Number(digit[1]);
  const CH = "一二三四五六七八九十";
  const chinese = question.match(new RegExp(`第([${CH}])[檔支個家只]`));
  if (chinese) return CH.indexOf(chinese[1]) + 1;
  return null;
}

/**
 * 這一句沒有寫出股票名稱、但顯然是在追問上文提過的某一檔時，從對話紀錄裡
 * 把那一檔找回來。只在完全沒解析到股票、也不是全市場篩選/主題問題時才會被
 * 呼叫（見 answerQuestion 裡的呼叫條件），所以不會搶走篩選類問題的資料。
 */
export async function resolveFollowupTargets(
  question: string,
  history: ChatTurn[]
): Promise<Array<{ symbol: string; market: Market | undefined }>> {
  const trimmed = question.trim();
  const hasPronoun = PRONOUN_FOLLOWUP_PATTERN.test(trimmed);
  const bareMetric =
    METRIC_FOLLOWUP_PATTERN.test(trimmed) &&
    trimmed.length <= METRIC_FOLLOWUP_MAX_LEN &&
    !SCREENING_WORDS_PATTERN.test(trimmed);
  const verifyOrTime =
    trimmed.length <= VERIFY_OR_TIME_FOLLOWUP_MAX_LEN &&
    VERIFY_OR_TIME_FOLLOWUP_PATTERN.test(trimmed) &&
    !SCREENING_WORDS_PATTERN.test(trimmed);
  if (!hasPronoun && !bareMetric && !verifyOrTime) return [];

  const ordinal = parseOrdinal(trimmed);
  // 由新到舊找第一則真的有提到股票的訊息（通常是 AI 上一則點名了幾檔的回答）。
  for (let i = history.length - 1; i >= 0; i--) {
    const found = await guessSymbolsFromText(history[i].content);
    if (found.length === 0) continue;
    const picked = ordinal != null && found[ordinal - 1] ? found[ordinal - 1] : found[0];
    return [{ symbol: picked.symbol, market: picked.market }];
  }
  return [];
}

// Matches the chat widget's "📋 分析我的關注清單" button text and close
// variants — a user reported the resulting analysis reading as "just data"
// (a one-line quote+P&L per stock, see buildHoldingsGrounding above) and
// asked for a real per-stock analysis instead: technical+fundamental+chip+
// news synthesized together, a trend view, and a specific suggested action
// with a price range — the same depth a single-stock question already gets
// via buildStockGrounding, just run for every watchlist entry at once.
// Gated behind this intent check (rather than always running whenever
// `holdings` is non-empty) so a casual, unrelated question that happens to
// still be carrying the watchlist along doesn't pay for a full
// buildStockGrounding() fan-out it didn't ask for.
export const HOLDINGS_ANALYSIS_INTENT_PATTERN =
  /分析.{0,4}(我|一下)?.{0,4}(關注|持股|清單)|(關注|持股)清單.{0,6}分析|看看.{0,4}(我|我的)?.{0,4}(關注|持股)|我的?(關注|持股).{0,6}(如何|怎麼樣|狀況|表現)/;

// Matches the exact phrasing ChatWidget.tsx's "問AI關於<股票>" button
// pre-fills ("關於 台積電（2330），最近走勢如何？") plus close variants a
// user might type themselves after opening that same context. See
// wantsSingleStockAnalysis's own comment for why this is gated on
// contextSymbol rather than firing for any question that happens to
// mention "走勢".
export const SINGLE_STOCK_ANALYSIS_INTENT_PATTERN =
  /最近走勢|該不該(買|賣|進場|出場)|值得(買|進場)|現在.{0,4}(能不能|可以|該).{0,4}(買|賣|進場)|(買|賣)點|現在.{0,6}(如何|怎麼樣|狀況)/;
