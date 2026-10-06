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
  /(建議|推薦|推荐).{0,8}(買|布局|佈局|進場|入手|投資|加碼)|(買|布局|佈局|進場|入手|投資).{0,4}(哪|什麼|甚麼|啥|哪些|哪一)|有什麼.{0,8}(可以|適合|值得).{0,4}(買|布局|佈局|進場|入手)|可以(買|布局|佈局|進場).{0,3}(什麼|甚麼|哪)|(挑|選).{0,3}(幾|一|兩|二|三)(檔|支)/;
const EXPLICIT_HOLDINGS_SCOPE_PATTERN = /(我的|我).{0,3}(關注|自選|持股|持有|庫存)|關注清單|自選股|持股裡|手上(的|有)/;

/** 這句（或上一句使用者的話）是不是在談自己的持股／關注清單／成本損益。
 *  沒有的話，關注清單只當背景名單附上，不附逐檔報價損益（見 ask.ts holdingsForGrounding）。 */
export const HOLDINGS_TOPIC_PATTERN =
  /(我的|我).{0,3}(關注|自選|持股|持有|庫存|部位)|關注清單|自選股|持股|持有|庫存|手上|成本|損益|賺|賠|虧|停損|止損|停利|止盈|續抱|加碼|減碼|該賣|要賣|賣掉|攤平|套牢|解套/;

// 2026-10-05 使用者回報：分析關注清單把 1528 等判「建議減碼或出場」，3 分鐘後問「持有名單建議盤後賣掉哪些?」
// 卻回「沒有建議賣出的」——第二題沒命中 HOLDINGS_ANALYSIS_INTENT_PATTERN，走輕量清單、沒附評等。
// 談持股（HOLDINGS_TOPIC_PATTERN 成立）且是在做決策（賣不賣、賣哪些、停損停利、加減碼…）時，
// 輕量清單也要附每檔「含個人成本的本站評等」（grounding/holdings.ts rateHoldings），結論才會一致。
export const HOLDINGS_DECISION_PATTERN =
  /賣|停損|止損|停利|止盈|減碼|加碼|出場|出清|續抱|抱著|留著|該不該|要不要|建議|怎麼(辦|處理|操作)|評等|風險|分析/;

// 2026-10-05 使用者👎「仁寶何時進場」回答太淺。判斷題（買不買、何時進場、要不要賣、走勢、比較）與
// 「再多分析／詳細一點／為什麼」放寬輸出長度（ask.ts maxOutputTokens；長度規則見 RULE_CONCISE_ANSWER）。
export const JUDGMENT_QUESTION_PATTERN =
  /買不買|能不能(買|賣|進場)|可以(買|進場)|該不該|要不要|何時|什麼時候|甚麼時候|進場|出場|賣不賣|走勢|怎麼看|看法|比較|值得|推薦|建議.{0,4}(買|賣)/;
export const DEEPER_ANALYSIS_REQUEST_PATTERN = /再多|多分析|詳細|深入|仔細|為什麼|為何|展開|說清楚/;

// 2026-10-04 使用者回報：先問「2330 最近走勢如何？」，接著問「建議買嗎?」，AI 卻改推薦全市場
// 其他股票——BUY_IDEA_INTENT_PATTERN 第一段「建議.{0,8}買」把這句是非題當成「建議買什麼」。
// 全市場推薦必須同時有「要列一份清單」的字眼才算；沒指名對象的買賣是非題見 isBareTradeYesNoQuestion。
const LIST_REQUEST_PATTERN =
  /什麼|甚麼|什么|啥|哪|推薦|推荐|名單|名单|清單|清单|標的|标的|(幾|几|一|兩|两|二|三|四|五|\d)\s*(檔|档|支|只)|股票|個股|个股|其他|別的|别的/;

/** 開放式『建議買什麼』且沒有明講只限自己清單 → 範圍是整個市場，不是關注清單。 */
export function wantsMarketWideBuyIdea(question: string): boolean {
  return (
    BUY_IDEA_INTENT_PATTERN.test(question) &&
    LIST_REQUEST_PATTERN.test(question) &&
    !EXPLICIT_HOLDINGS_SCOPE_PATTERN.test(question)
  );
}

// 「建議買嗎」「可以買嗎」「要不要買」「值得買嗎」「該賣嗎」：沒指名對象、也沒要一份清單的短句
// 買賣是非題。對話裡有正在談的個股時，就是在追問那一檔（ask.ts 先用 resolveFollowupTargets
// 找回那一檔，找到就不會再走全市場篩選）；對話裡沒有個股時維持原本的全市場行為。
const TRADE_VERB_PATTERN = /買|买|賣|卖|進場|进场|出場|出场|加碼|加码|減碼|减码|入手|布局|佈局|續抱|续抱|抱著|抱着|停損|停损|停利/;
const YES_NO_PATTERN = /嗎|吗|要不要|該不該|该不该|能不能|可不可以|值不值得|好不好|適不適合|适不适合|呢|[?？]$/;
const BARE_TRADE_YESNO_MAX_LEN = 16;
export function isBareTradeYesNoQuestion(question: string): boolean {
  const trimmed = question.trim();
  return (
    trimmed.length <= BARE_TRADE_YESNO_MAX_LEN &&
    TRADE_VERB_PATTERN.test(trimmed) &&
    YES_NO_PATTERN.test(trimmed) &&
    !LIST_REQUEST_PATTERN.test(trimmed) &&
    !SCREENING_WORDS_PATTERN.test(trimmed)
  );
}

/**
 * 方法／原則題（「你怎麼判斷是要放著還是認賠出場?」「停損要怎麼設」）：問的是判斷方式，不是某一檔。
 * 沒有指代詞（這檔／它／那支…）時，不可把上一則回答裡的股票當成追問目標
 * （2026-10-06 17:10 使用者回報：被答成啟碁的個股分析，「這不是我提問要的答案」）。
 */
const METHOD_QUESTION_PATTERN = /怎麼判斷|如何判斷|怎樣判斷|判斷標準|依據什麼|根據什麼|什麼原則|有什麼原則|怎麼決定|如何決定|要怎麼設|怎麼設定|什麼時候(?:該|要|應該)/;
const STOCK_PRONOUN_PATTERN = /這檔|那檔|這支|那支|這隻|那隻|它|牠|這家|那家|這間|這個股|該股/;
export function isMethodQuestion(question: string): boolean {
  return METHOD_QUESTION_PATTERN.test(question) && !STOCK_PRONOUN_PATTERN.test(question);
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

// 「快要／即將交叉」的問法（2026-10-05：使用者問「那有快黃金交叉的嗎?」原本因為沒有
// 「有沒有/哪些」這類找股動詞而接不住）。這類說法本身就是在找「快要發生交叉的股票」，
// 不需要再配找股動詞；同樣只在問句沒指到特定股票時才檢查（見上方註解）。
export const TECH_NEAR_CROSS_PATTERN =
  /(快要?|即將|即将|將要|将要|就要|準備|准备|接近|逼近)\s*(KD|MACD|K值|D值)?(線|线|指標|指标)?\s*的?\s*(黃金交叉|黄金交叉|死亡交叉|交叉|金叉|死叉)|要交叉了/i;

// 「有…的嗎」這種存在問句、「都黃金交叉」這種多條件同時成立的說法，本身就是在找股票（2026-10-05 使用者回報：
// 對話中問「那有MACD與KD線都黃金交叉的嗎?」，沒有「有沒有／哪些」找股動詞而接不住，這輪沒附篩選清單，
// AI 只好回答「加權指數今天沒有同時出現 MACD 與 KD 黃金交叉」；當天其實有波若威、台光電）。
// 排除「有什麼用／有效嗎」這類在問指標本身的句子。
export const TECH_EXISTENCE_QUESTION_PATTERN =
  /有(?!什麼|甚麼|什么|用|效|意義|意义|差|關|关|沒有|没有).{0,24}(的嗎|的吗|的呢|嗎|吗)\s*[?？]?\s*$/;
export const TECH_ALL_CONDITIONS_PATTERN =
  /都\s*(呈現|呈|出現|出现|有|是|已)?\s*(黃金交叉|黄金交叉|金叉|死亡交叉|死叉|多頭排列|多头排列|空頭排列|空头排列)/;

/** 這句話本身是不是「用技術指標篩股票」（不看對話脈絡）。 */
function isTechScreenQuestion(q: string): boolean {
  if (TECH_NEAR_CROSS_PATTERN.test(q)) return true;
  if (!TECH_INDICATOR_PATTERN.test(q)) return false;
  return TECH_SCREEN_VERB_PATTERN.test(q) || TECH_EXISTENCE_QUESTION_PATTERN.test(q) || TECH_ALL_CONDITIONS_PATTERN.test(q);
}

export function conversationWantsTechScreen(question: string, history: ChatTurn[]): boolean {
  if (isTechScreenQuestion(question)) return true;
  // 極短的接續追問（「那KD呢」「其他呢」）本身不成句，靠對話脈絡判斷——
  // 跟 conversationWantsMovers 完全同一套邏輯，理由見那裡的註解。
  if (!isFollowupShape(question)) return false;
  return history.some(
    (turn) =>
      turn.role === "user" &&
      isTechScreenQuestion(turn.content)
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
  const bareTradeYesNo = isBareTradeYesNoQuestion(trimmed);
  if (!hasPronoun && !bareMetric && !verifyOrTime && !bareTradeYesNo) return [];

  // 只有「建議買嗎」這種是非題觸發時：主詞是使用者自己最近問的那一檔（AI 回答裡可能順帶提到
  // 別的公司，不能拿來當主詞）；使用者沒講過個股時，只在上一則有提到股票的 AI 回答「恰好只有
  // 一檔」才沿用——AI 剛列了好幾檔推薦時，「可以買嗎」指的是哪檔不明確，回空讓它走原本的流程。
  if (bareTradeYesNo && !hasPronoun && !bareMetric && !verifyOrTime) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role !== "user") continue;
      const found = await guessSymbolsFromText(history[i].content);
      if (found.length > 0) return [{ symbol: found[0].symbol, market: found[0].market }];
    }
    for (let i = history.length - 1; i >= 0; i--) {
      const found = await guessSymbolsFromText(history[i].content);
      if (found.length === 0) continue;
      return found.length === 1 ? [{ symbol: found[0].symbol, market: found[0].market }] : [];
    }
    return [];
  }

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

// 2026-10-05 使用者回報：先問「快要黃金交叉」得到一份清單，再問「這幾檔有你特別看好的嗎?」，
// 回答卻跑出清單外的台積電——「這幾檔」含「幾檔」被 LIST_REQUEST_PATTERN 當成全市場推薦，
// 走了今日建議名單。指代「上一則 AI 回答列出的那一整份清單」的說法要先攔下來，解析成清單裡的
// 全部股票（上限 LIST_REFERENCE_MAX_TARGETS），每檔附個股資料與本站綜合評等。
// 2026-10-06 13:13 使用者回報：「這3檔分別建議買還是不買?」沒被認成指代（只認「這幾檔」），被當成全市場推薦，
// AI 答「三檔皆未列入建議買進名單，因此先不要買」——實際三檔評等都是建議買進。數字／國字檔數也要認。
export const LIST_REFERENCE_PATTERN =
  /[這这那]\s*[0-9０-９一二兩两三四五六七八]\s*[檔支個家只档个]|這幾[檔支個家只]|这几[档支个家只]|那幾[檔支個家只]|那几[档支个家只]|這些|这些|那些|上面(這|那)?(些|幾)|上述|剛剛?(那|這)幾|刚刚?(那|这)几|剛才(那|這)幾|名單(裡|中|內|上)|清單(裡|中|內|上)|名单(里|中|内)|清单(里|中|内)|以上(這|那)?(些|幾)/;
export const LIST_REFERENCE_MAX_TARGETS = 8;

export function isListReferenceQuestion(question: string): boolean {
  return LIST_REFERENCE_PATTERN.test(question.trim()) && !EXPLICIT_HOLDINGS_SCOPE_PATTERN.test(question);
}

/**
 * 「這幾檔／這些／上面這些／剛剛那幾檔／名單裡」→ 由新到舊找最近一則「列了 2 檔以上股票」的
 * AI 回答，回傳其中全部股票（依出現順序，最多 LIST_REFERENCE_MAX_TARGETS 檔）。找不到就回空陣列。
 */
export async function resolveListReferenceTargets(
  history: ChatTurn[]
): Promise<Array<{ symbol: string; market: Market | undefined }>> {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "assistant") continue;
    const found = await guessSymbolsFromText(history[i].content, { max: LIST_REFERENCE_MAX_TARGETS, knownOnly: true });
    if (found.length >= 2) return found.map((f) => ({ symbol: f.symbol, market: f.market }));
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

// ---------------------------------------------------------------------------
// 使用者明確問「過去某一天／某段期間」（昨天、上週、10月1日、這個月、近10天）時，
// 個股【歷史脈絡】額外附該期間的逐日收盤／漲跌／成交量（見 grounding/history.ts）。
// 偵測刻意保守：只認得下面幾種明確說法，對不上就不附（不附只是少一段，不會答錯）。
// ---------------------------------------------------------------------------

/** 期間：日曆區間（含頭尾，YYYY-MM-DD），或「最近 N 個交易日」 */
export type HistoryPeriod =
  | { label: string; from: string; to: string }
  | { label: string; lastTradingDays: number };

/** 逐日明細最多列幾個交易日 */
export const HISTORY_PERIOD_MAX_DAYS = 20;

const ZH_DIGITS: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function parseSmallNumber(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  if (raw === "十") return 10;
  const m = raw.match(/^([一二兩两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? ZH_DIGITS[m[1]] : 1) * 10 + (m[2] ? ZH_DIGITS[m[2]] : 0);
  return ZH_DIGITS[raw];
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

/** 月/日（沒寫年份）→ 最近一次出現的那天：比今天晚就當成去年。不合法日期回 undefined。 */
function monthDayToIso(month: number, day: number, today: Date, year?: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  let y = year ?? today.getUTCFullYear();
  let d = new Date(Date.UTC(y, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return undefined;
  if (year == null && d > today) {
    y -= 1;
    d = new Date(Date.UTC(y, month - 1, day));
  }
  return isoOf(d);
}

// 用 String.raw 保留反斜線：一般字串／樣板字串裡的 \d、\s 會被 JS 吃掉反斜線，變成字母 d、s，
// 日期樣式就永遠對不到（2026-10-04 補測試時發現「10月1日」「9月22日到10月2日」從來沒命中過）。
const MD = String.raw`(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|號|号)`;
const RANGE_MD_PATTERN = new RegExp(
  String.raw`${MD}\s*(?:到|至|~|～|-|－)\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*(?:日|號|号)`
);
const SINGLE_MD_PATTERN = new RegExp(MD);
const ISO_DATE_PATTERN = /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/;
// 「10/1」這種寫法也可能是分數或比例，所以要同一句裡有明顯在問行情的字才算。
const SLASH_MD_PATTERN = /(?<![\d/])(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])(?![\d/%])/;
const SLASH_CONTEXT_PATTERN = /那天|當天|当天|收盤|收盘|漲|涨|跌|股價|股价|成交量|表現|表现|走勢|走势|法人|外資|外资/;
const LAST_N_DAYS_PATTERN = /(?:最近|近|過去|过去|前)\s*(\d{1,2}|[一二兩两三四五六七八九十]{1,3})\s*(?:個|个)?\s*(?:交易日|天|日)/;
const RECENT_FEW_DAYS_PATTERN = /(?:最近|近|這|这)幾天|(?:最近|近|過去|过去)\s*(?:一|1)\s*(?:週|周|星期|禮拜|礼拜)/;
const DAY_BEFORE_YESTERDAY_PATTERN = /前天/;
const YESTERDAY_PATTERN = /昨天|昨日/;
const LAST_WEEK_PATTERN = /上(?:個|个)?(?:週|周|星期|禮拜|礼拜)/;
const THIS_WEEK_PATTERN = /(?:這|这|本)(?:個|个)?(?:週|周|星期|禮拜|礼拜)/;
const LAST_MONTH_PATTERN = /上(?:個|个)?月(?!營收|营收)/;
const THIS_MONTH_PATTERN = /(?:這|这|本)(?:個|个)?月(?!營收|营收)/;

/**
 * today：台北日曆日。命中回傳期間，否則 undefined。順序：明確日期區間 → 單一明確日期 →
 * 「近N天」→ 前天/昨天 → 上週/這週 → 上個月/這個月。
 */
export function detectHistoryPeriod(
  question: string,
  today: { year: number; month: number; day: number }
): HistoryPeriod | undefined {
  const t = new Date(Date.UTC(today.year, today.month - 1, today.day));

  const range = question.match(RANGE_MD_PATTERN);
  if (range) {
    const m1 = parseInt(range[1], 10);
    const from = monthDayToIso(m1, parseInt(range[2], 10), t);
    const to = monthDayToIso(range[3] ? parseInt(range[3], 10) : m1, parseInt(range[4], 10), t);
    if (from && to && from <= to) return { label: `${from}～${to}`, from, to };
  }
  const iso = question.match(ISO_DATE_PATTERN);
  if (iso) {
    const d = monthDayToIso(parseInt(iso[2], 10), parseInt(iso[3], 10), t, parseInt(iso[1], 10));
    if (d) return { label: d, from: d, to: d };
  }
  const single = question.match(SINGLE_MD_PATTERN);
  if (single) {
    const d = monthDayToIso(parseInt(single[1], 10), parseInt(single[2], 10), t);
    if (d) return { label: d, from: d, to: d };
  }
  const slash = SLASH_CONTEXT_PATTERN.test(question) ? question.match(SLASH_MD_PATTERN) : null;
  if (slash) {
    const d = monthDayToIso(parseInt(slash[1], 10), parseInt(slash[2], 10), t);
    if (d) return { label: d, from: d, to: d };
  }
  const lastN = question.match(LAST_N_DAYS_PATTERN);
  if (lastN) {
    const n = parseSmallNumber(lastN[1]);
    if (n != null && n >= 1) {
      const days = Math.min(n, HISTORY_PERIOD_MAX_DAYS);
      return { label: `最近${days}個交易日`, lastTradingDays: days };
    }
  }
  if (RECENT_FEW_DAYS_PATTERN.test(question)) return { label: "最近5個交易日", lastTradingDays: 5 };
  if (DAY_BEFORE_YESTERDAY_PATTERN.test(question)) {
    const d = isoOf(addDays(t, -2));
    return { label: `前天（${d}）`, from: d, to: d };
  }
  if (YESTERDAY_PATTERN.test(question)) {
    const d = isoOf(addDays(t, -1));
    return { label: `昨天（${d}）`, from: d, to: d };
  }
  // 週一為一週的第一天
  const mondayThisWeek = addDays(t, -((t.getUTCDay() + 6) % 7));
  // 週六、週日問「上週」，使用者指的是剛結束的這個交易週（週一～週五），不是更早一週
  // （2026-10-04 週日實測：問「6488上週外資怎麼買」被解成 9/21～9/27，而不是剛過完的 9/28～10/2）。
  const isWeekend = t.getUTCDay() === 0 || t.getUTCDay() === 6;
  if (LAST_WEEK_PATTERN.test(question) && isWeekend) {
    const from = isoOf(mondayThisWeek);
    const to = isoOf(addDays(mondayThisWeek, 4));
    return { label: `上週（剛結束的交易週 ${from}～${to}）`, from, to };
  }
  if (LAST_WEEK_PATTERN.test(question)) {
    const from = isoOf(addDays(mondayThisWeek, -7));
    const to = isoOf(addDays(mondayThisWeek, -1));
    return { label: `上週（${from}～${to}）`, from, to };
  }
  if (THIS_WEEK_PATTERN.test(question)) return { label: `這週（${isoOf(mondayThisWeek)}起）`, from: isoOf(mondayThisWeek), to: isoOf(t) };
  if (LAST_MONTH_PATTERN.test(question)) {
    const first = new Date(Date.UTC(today.year, today.month - 2, 1));
    const last = new Date(Date.UTC(today.year, today.month - 1, 0));
    return { label: `上個月（${isoOf(first).slice(0, 7)}）`, from: isoOf(first), to: isoOf(last) };
  }
  if (THIS_MONTH_PATTERN.test(question)) {
    const from = isoOf(new Date(Date.UTC(today.year, today.month - 1, 1)));
    return { label: `這個月（${from.slice(0, 7)}）`, from, to: isoOf(t) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 主題新聞意圖（2026-10-06）：「今天有沒有 美國 伊朗的新聞」「最近 Fed 有什麼消息」。
// 本站原本只有固定的台股／美股市場新聞與個股新聞，沒有依使用者問的主題搜尋，
// 模型只能回「資料裡沒有」。這裡只負責「抽出主題關鍵字」（唯一入口）；要不要真的搜尋
// （問句沒指到個股才搜，個股新聞走既有個股流程）由 ask.ts 決定，搜尋本身在 lib/data/topicNews.ts。
// ---------------------------------------------------------------------------

/** 問句在問新聞／消息類（沒有這類字眼就不是主題新聞題）。 */
const TOPIC_NEWS_WORD_PATTERN =
  /新聞|新闻|消息|報導|报道|報道|最新(情況|情况|狀況|状况|動態|动态|進展|进展|發展|发展)|發生(了)?(什麼|甚麼|啥)|发生(了)?(什么|啥)|有什麼事|頭條|头条|快訊|快讯/;
/** 指代上文某則新聞的問法（「這則新聞對…的影響」）不是在要新的新聞搜尋。 */
const TOPIC_NEWS_ANAPHORA_PATTERN = /這則|這篇|這個新聞|這條|这则|这篇|这条|上面|剛剛那|剛才那|那則|那篇/;
/** 抽完主題後只剩這些泛稱＝問的是大盤層級新聞，既有「台股／美股市場新聞」就涵蓋，不另外搜。 */
const TOPIC_GENERIC_ONLY_PATTERN = /^(台股|美股|大盤|股市|市場|股票|財經|财经|金融|投資|投资|盤勢|盘势|行情|國際|国际|全球|世界)+$/;
/** 要從問句剝掉的虛詞與新聞用語（順序有意義：長的在前）。 */
const TOPIC_STRIP_PATTERNS: RegExp[] = [
  /(對|对)[^，。？?！!]{0,12}?(有什麼|有甚麼|有啥|會有什麼|会有什么)?(的)?(影響|影响|衝擊|冲击|利多|利空)(嗎|吗)?/g,
  /最新(情況|情况|狀況|状况|動態|动态|進展|进展|發展|发展)/g,
  /發生(了)?(什麼|甚麼|啥)(事情|事)?|发生(了)?(什么|啥)(事情|事)?|有什麼事|有什么事/g,
  /有沒有|有没有|有無|有无|有什麼|有甚麼|有什么|有哪些|有嗎|有吗|還有|还有|有關於|有关于|關於|关于|有關|有关|相關|相关/g,
  /新聞|新闻|消息|報導|报道|報道|頭條|头条|快訊|快讯/g,
  /今天|今日|昨天|昨日|最近|近期|近來|近来|目前|現在|现在|這幾天|这几天|這兩天|这两天|這陣子|这阵子|近\s*\d+\s*(天|日)|這週|這周|本週|本周|最新/g,
  /請問|请问|幫我|帮我|麻煩|麻烦|請|请|想知道|我想知道|告訴我|告诉我|查一下|查查|查詢|查询|看一下|看看|搜尋|搜索|一下|是否|是不是|會不會|会不会/g,
  /[的了嗎吗呢啊吧喔哦呀]/g,
  /[，。、？?！!：:；;「」『』“”"'（）()]/g,
];
const TOPIC_NEWS_MAX_QUESTION_LEN = 40;
const TOPIC_NEWS_MIN_TOPIC_LEN = 2;
const TOPIC_NEWS_MAX_TOPIC_LEN = 24;

/**
 * 問句是「某個主題的新聞／消息」時，回傳要搜尋的主題關鍵字（多個詞用單一空白隔開）；否則回 null。
 * 例：「今天有沒有 美國 伊朗的新聞」→「美國 伊朗」、「最近 Fed 有什麼消息」→「Fed」。
 * 只抽關鍵字，不判斷主題是不是個股（「台積電最新新聞」也會回「台積電」，由呼叫端在問句已指到個股時略過）。
 */
export function extractTopicNewsQuery(question: string): string | null {
  const q = question.trim();
  if (!q || q.length > TOPIC_NEWS_MAX_QUESTION_LEN) return null;
  if (!TOPIC_NEWS_WORD_PATTERN.test(q)) return null;
  if (TOPIC_NEWS_ANAPHORA_PATTERN.test(q)) return null;
  let rest = q;
  for (const p of TOPIC_STRIP_PATTERNS) rest = rest.replace(p, " ");
  const topic = rest.replace(/\s+/g, " ").trim();
  if (topic.length < TOPIC_NEWS_MIN_TOPIC_LEN || topic.length > TOPIC_NEWS_MAX_TOPIC_LEN) return null;
  if (TOPIC_GENERIC_ONLY_PATTERN.test(topic.replace(/\s+/g, ""))) return null;
  return topic;
}
