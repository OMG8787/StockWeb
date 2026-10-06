# AI 管線資料流與單一真相來源地圖

> 最後更新：2026-10-06（整合稽核）。CLAUDE.md「功能互通原則」：新增或修改任何一個環節前先查這份地圖，確認上下游（快取 key 版本、紀錄欄位、看板、回測、評測、整合測試）都跟著更新，並更新這份文件。
> 守門測試：`src/__tests__/crossEntryConsistency.test.ts`（`npm test` 每次都跑）；正式資料比對：`npx tsx scripts/eval/consistency.ts`。

## 1. 總覽圖

```mermaid
flowchart TD
  subgraph 上游資料["上游資料（lib/data，各自有快取）"]
    Q[getQuote 報價]
    K[getChart 3m 日K]
    CH[getChips 三大法人]
    CR[getChipsRatios 持股結構]
    MG[marginSignal.ts 融資融券組合判讀<br/>漲跌×融資增減×融券增減，只列資訊、不計分]
    F[getFundamentals／getEarnings／重訊]
    TX[getTaiexCandles 加權 6m 日K<br/>learning:taiex:6m:{日期} 1h]
  end

  subgraph 時段["時段（唯一）"]
    MS[marketStatus.ts MARKET_SESSIONS<br/>開收盤時刻唯一定義]
    PS[pollingSchedule.ts<br/>taipeiDayKey／getTwTradingPhase]
    TS[tradingStance.ts getTradingStance<br/>立場文字／今日 vs 明日操作]
    AS[aiSchedule.ts 較強模型重寫時點]
    MS --> PS --> TS
    PS --> AS
  end

  subgraph 市況["市況（兩種、各一個定義）"]
    RG[learning/regime.ts classifyRegime<br/>多頭／空頭／盤整（學習分組）]
    WM[siteRating.ts WEAK_MARKET_RET60_PCT＋<br/>regime.ts marketReturnPct（弱市況提示）]
  end
  TX --> RG
  TX --> WM

  subgraph 評等["評等（唯一）"]
    CORE[ratingCore.ts computeRatingCore<br/>訊號→五面向→價位框架→追高→computeSiteRating]
    SR[stockRating.ts getStockRating<br/>stock-rating:v5:{代號}:{台北日期} 10 分<br/>翻轉2日確認（rating-confirm:v1）]
    HR[holdingRating.ts describeRatingForHolding<br/>含個人成本：停利提示＋持有中出場]
    CORE --> SR --> HR
  end
  Q & K & CH & CR & F --> SR
  Q & CH --> MG
  MG --> SG & AG & BR
  WM --> SR
  RG --> SR

  subgraph 入口
    SG[grounding/stock.ts 個股資料<br/>AI 問答個股題／問AI關於]
    HG[grounding/holdings.ts<br/>持股輕量清單／深度分析]
    AG[actionGrounding.ts＋actionPicks.ts<br/>今日建議／明日操作建議名單]
    TSG[grounding/techScreen.ts 技術篩選]
    ASK[ask.ts answerQuestion]
    AB[actionBrief.ts getActionBrief]
    BR[brief.ts 今日快報]
  end
  SR --> SG & HG & AG & TSG
  HR --> SG & HG
  AG --> AB
  AB -->|名單| ASK
  SG & HG & TSG --> ASK
  TS --> ASK & AB

  subgraph AI["AI 呼叫與回答後檢查"]
    PV[provider.ts callAiProviders<br/>繁中正規化 normalizeZhTw]
    GM[gemini.ts 分級＋每日配額<br/>gemini:calls:{太平洋日}:{模型}]
    PP[ask.ts finalizeAiAnswer<br/>postProcessAiAnswer（清標記→去評等標籤→名稱星號→錯字確認句→numberGuard→ratingConsistencyGuard 先不要買刪價位→guardHeldAnswer 持有建議逐字→ensureRatingChangeExplained 評等變動補說明）<br/>→answerCardIssues→同模型重生一次→仍不過用程式版]
    NG[numberGuard.ts guardAnswerNumbers]
    PV --> GM
  end
  ASK --> PV --> PP
  AB --> PV
  AB --> NG
  BR --> PV

  subgraph 學習["評等紀錄與學習"]
    RL[ratingLog.ts logRating<br/>rating-log:v1:{日期} field＝ratingLogField]
    AJ[aiJudge.ts AI 判斷層<br/>ai-judge:v1:{日期}:{代號}，寫回紀錄 ai 欄位]
    LJ[learningStore.ts runLearningUpdate<br/>ratingLogToEval→learning:v1:eval:{日期}]
    EX[learning/experienceText.ts<br/>相似案例＋教訓]
    SB[/scoreboard、/api/learning]
    SP[simPortfolio/run.ts AI 模擬投資組合<br/>sim-portfolio:v1:state；09:30／13:00 盤中、13:35 盤後委託、14:35 結算]
    SPA[simPortfolio/archive.ts 永久封存<br/>trades／decisions／daily:{YYYY-MM}]
    SPR[simPortfolio/review.ts 收盤後 AI 檢討<br/>learning:v1:sim-review:{日期}]
  end
  AB -->|名單代號| SP
  SR -->|source sim-portfolio| SP
  HR --> SP
  SP --> SPR
  SP --> SPA
  SR -->|source| RL
  AJ --> RL
  RL --> LJ --> SB
  LJ --> EX
  EX --> SG
  EX --> AJ

  subgraph 離線["離線工具"]
    BT[scripts/backtest run／wide／regime／weights]
    EV[scripts/eval run.ts（跨模型）＋consistency.ts（跨入口）]
  end
  CORE --> BT
  ASK --> EV
  PP --> EV
```

## 2. 每個結論／數字的唯一來源

| 結論／數字 | 唯一來源函式（檔案） | 常數 | 誰用 |
|---|---|---|---|
| 評等（建議買進／先不要買、已持有字樣、理由、拉回加碼價、出場價、改判條件） | `computeRatingCore()`（ratingCore.ts）→ `computeSiteRating()`（siteRating.ts） | `QUALIFY_MIN_SUPPORT／QUALIFY_MAX_AGAINST`（actionScoring.ts）、`VETO_FACETS`、`RISK_NOTE_ONLY_GUARDS`、`NEAR_ZONE_PCT` | stockRating.ts（正式站）、5 支回測（stability.ts 帶 chipsWindow＋confirmPrev） |
| 融資融券組合判讀（追高風險／可能軋空／籌碼沉澱／空方佔優／中性） | `computeMarginSignal()`＋`marginSignalLine()`（marginSignal.ts；資料與文字在 marginSignalData.ts） | `MARGIN_SIGNAL_PRICE_MOVE_PCT`＝1、`MARGIN_BIG_CHANGE_PCT`＝3（且≥`MARGIN_MIN_CHANGE_LOTS`＝100張）、`SHORT_BIG_CHANGE_PCT`＝10（且≥`SHORT_MIN_CHANGE_LOTS`＝30張）、區塊標題 `MARGIN_SIGNAL_TITLE` | 個股資料（grounding/stock.ts，askSystemCompose 依標題帶 `RULE_MARGIN_SIGNAL`）、今日建議體檢表（actionGrounding.describeCandidate）、今日快報（brief.ts）。**只列資訊、不計分**（回測結果見 docs/backtest/2026-10-margin-signal.md）；融資融券交易日跟報價對不上時（收盤後～21 點）改用日K算那天漲跌，沒日K就不判讀；只有非中性才附 |
| 籌碼面近 N 日累計（研究用，正式站未啟用） | `sumChipsWindow()`（chipsWindow.ts） | `CHIPS_WINDOW_DAYS`＝5 | 只有 stability.ts 回測；回測沒有比單日＋2日確認好 |
| 本站把握程度（只給建議買進；高＝大盤不偏弱且連續≥3日、低＝大盤偏弱且剛轉買≤2日） | `ratingConfidence()`／`confidenceRank()`／`confidenceText()`／`describeConfidenceGrades()`（siteRating.ts）；連續天數＝confirmState.streak（沒有狀態時 `stateFromRatingLog()` 用評等紀錄回推） | `CONFIDENCE_HIGH_MIN_STREAK`＝3、`CONFIDENCE_LOW_MAX_STREAK`＝2 | describeSiteRating 評等行、今日建議排序（selectPickGroups，不再採用 AI order）與逐檔顯示、全市場推薦名單排序、技術篩選評等排序、關注清單僅關注彙整（formatWatchRatingSummary）、問高把握（RULE_HIGH_CONFIDENCE）、結論卡「把握程度（照抄）」行（decisionCard.ts，未持有且建議買進才印）；**回答後保證** `ensureConfidenceMentioned()`（confidenceMention.ts）：買賣判斷題／關注清單深度分析回答提到建議買進的股票卻沒講把握程度，程式插在該檔結論句後（插不進去才附在最後），2026-10-07 四入口比較 ③④② 把握程度通過率 0～75%→100% |
| 評等翻轉確認（新結論連續 2 個交易日才換，破底立即） | `applyRatingConfirmation()`（ratingStability.ts）→ `computeSiteRating({confirm})`（pendingChange、confirmState）；狀態 `readConfirmBase()／writeConfirmState()`（ratingConfirmStore.ts） | `MAX_GAP_DAYS`＝7、交易日＝最新一根日K日期 | stockRating（正式站）、stability.ts 回測、結論卡主要風險 |
| 評等快取＋I/O | `getStockRating()`／`getStockRatings()`（stockRating.ts） | `STOCK_RATING_TTL_MS`＝10 分、失敗 60 秒 | 個股資料、持股、今日建議、技術篩選、AI 問答名單行、consistency 評測 |
| 評等文字（給 AI 與名單） | `describeSiteRating()`（siteRating.ts） | `SITE_RATING_TITLE` | 個股資料、今日建議名單與「先不要買」區、AI 問答全市場名單、持股（未持有） |
| 價位框架（支撐／壓力／支撐區／出場／不追價） | `ratingPriceFramework()`（ratingCore.ts，興櫃不給）→ `computePriceFramework()`（priceLevels.ts） | `MIN_CANDLES`、`NEAR_ZONE_PCT` | 評等（存在 StockRatingResult.framework）、個股資料【價位參考】（評等失敗時的備援也走同一個） |
| 含成本的持股結論＋持有中出場 | `describeRatingForHolding()`（holdingRating.ts）＋`computeHoldingStop()`（holdingStop.ts）＋`applyHoldingCost()／checkTakeProfit()`（siteRating.ts） | `TAKE_PROFIT_PEAK_GAIN_PCT`＝8、`TAKE_PROFIT_GIVEBACK_FLOOR_PCT`＝0；**停利只在有買進日（`buyDate`）時判斷、只看買進日（含）之後的日K，沒有買進日就不觸發**（2026-10-06 國巨：舊近似法抓到幾個月前的高點）。買進日資料流：`WatchlistItem.buyDate／buyDateSrc`（watchlist.ts，股數由空變 >0 自動記台北今天＝auto、使用者改＝user 不被覆蓋、加碼不變、買回重設、賣出紀錄帶 `buyDate`）→ CSV（watchlistCsv.ts 末尾 3 欄）→ ChatWidget → /api/ask `parseHoldings` → `HoldingInput.buyDate` → grounding/holdings.ts、ask.ts（個股題）→ `describeRatingForHolding({costBasis, buyDate})`；模擬組合傳 `holdings.buyDay` | 個股資料（帶 costBasis＋buyDate）、`rateHoldings()`（輕量清單、深度分析、持股彙整） |
| 「賣哪些」彙整 | `formatHoldingRatingSummary()`（holdingRating.ts） | `HOLDING_SUMMARY_TITLE` | 輕量清單、深度分析 |
| 今日建議名單（分組上限、去重、不建議追） | `selectPickGroups()`、`selectNotChase()`（actionPicks.ts）；不建議追最後再用 `getStockRating` 驗證不是建議買進（actionGrounding.ts） | `PICK_GROUP_LIMIT`＝5、`NOT_CHASE_MAX_SUPPORT`＝1、`NOT_CHASE_VERIFY_ATTEMPTS`＝3 | 今日建議卡片、AI 問答全市場推薦（只取名單代號，評等行即時重讀） |
| 操作計畫（明日開盤／盤中可分批買、拉回加碼、出場） | `buildPlan()`（actionPicks.ts，價位全部來自評等） | — | 今日建議／明日操作建議 |
| 時段（盤前／盤中／盤後定價／收盤後／週末） | `getTwTradingPhase()`（pollingSchedule.ts） | 開收盤時刻 `MARKET_SESSIONS`、`TW_PRE_MARKET_START_MINUTES`（marketStatus.ts）；`TW_LIVE_END_MINUTES`＝14:30（pollingSchedule.ts） | tradingStance、ratingLog session、learningStore、評測假時鐘 |
| 盤中／收盤徽章 | `getMarketStatus()`（marketStatus.ts） | 同上 | UI、ask.ts 指標「盤中會變動」提示 |
| 回答立場文字、今日／明日模式、標題 | `getTradingStance()`（tradingStance.ts） | — | ask.ts、actionBrief.ts、ActionBriefHeading |
| 台北日期 | `taipeiDayKey()`（pollingSchedule.ts） | — | 所有快取 key、評等紀錄、ask.ts 歷史期間（2026-10-06 起 ask.ts 也改用它） |
| 較強模型重寫時點 | `actionBriefSlot()`／`dailyBriefSlot()`（aiSchedule.ts） | `ACTION_BRIEF_SLOTS_*`、`DAILY_BRIEF_SLOTS_*`、`AI_JUDGE_DAILY_CALL_LIMIT`＝10 | actionBrief.ts AI 解說層、brief.ts |
| 市況（學習分組） | `classifyRegime()`（learning/regime.ts）＋`getMarketRegime()`（regimeData.ts） | `REGIME_MA_DAYS`＝60、`REGIME_BAND_PCT`＝2、`REGIME_SLOPE_LOOKBACK`＝20 | 評等紀錄 rg、相似案例、權重、快報存檔、backtest/weights.ts |
| 弱市況提示 | `marketReturnPct()`（regime.ts）＋`weakMarketNote()`（siteRating.ts） | `WEAK_MARKET_RET60_PCT`＝5（backtest `REGIME_RET60_PCT`／`REGIME_A_PCT` 直接 import 它） | 評等 marketNote、今日建議頁首、回測市況分段 |
| 評等紀錄 key／field | `ratingLogKey()`／`ratingLogField()`（ratingLog.ts） | `RATING_LOG_KEY_PREFIX`＝`rating-log:v1:` | ratingLog、aiJudge（寫 ai 欄位）、learningStore、ratingChange |
| 評等紀錄 → 學習紀錄欄位對應 | `ratingLogToEval()`（learningStore.ts） | — | 每日學習工作 |
| 獎勵 | `computeOutcome()`、`conclusionReward()`、`tradeReward()`（learning/reward.ts） | 成本 `TRADE_COST_PCT`＝`TW_ROUND_TRIP_COST_PCT`（0.585%）、回撤懲罰 0.5 | 學習工作、backtest/weights.ts、模擬投資組合平倉 |
| 交易費率 | `lib/tradingCosts.ts`（純資料） | `TW_BUY_COMMISSION_RATE`、`TW_SELL_COMMISSION_RATE`、`TW_SELL_TAX_RATE`、`TW_ROUND_TRIP_COST_PCT` | 關注清單損益（portfolio.ts）、學習獎勵、模擬投資組合 |
| AI 模擬投資組合買賣 | `planSimOrders()`（決策＋選或不選原因）→`decideFill()`（漲跌停鎖死、五檔成交價、成交量上限、盤後定價）→`executeSimOrders()`／`applySimOrder()`（simPortfolio/rules.ts，純函式）；盤口 `getSimDepth()`（depth.ts，讀 MIS u／w／a／b／f／g／v，用 twse.ts 的 fetchMisRows）；`runSimPortfolio()`（run.ts，I/O） | `SIM_INITIAL_CAPITAL`、`SIM_MAX_POSITIONS`、`SIM_NEW_POSITION_PCT`、`SIM_MAX_POSITION_PCT`、`SIM_ADD_POSITION_PCT`、`SIM_MIN_TRADE_AMOUNT`、`SIM_LIMIT_LOCK_PCT`（讀不到五檔時的保守備援）、`SIM_MAX_VOLUME_SHARE`＝5%、`SIM_FIXED_FILL_TIME`＝14:30、`SIM_SLOTS` | 候選讀 getActionBrief().picks＋getStockRating（source `sim-portfolio`）；持有中讀 describeRatingForHolding＋computeHoldingStop；觸發＝warm-cache 順帶／`/api/cron/sim-portfolio`；顯示＝`/api/sim-portfolio`→首頁卡＋/portfolio |
| 相似案例＋教訓 | `describeExperience()`（learning/experienceText.ts）→ `lookupSimilar()`／`matchLessons()` | `SIMILAR_CASES_TITLE`、`LESSONS_TITLE` | 個股資料、AI 判斷層 |
| 評等跟前一交易日不同的說明 | `describeRatingChanges()`（ratingChange.ts，讀評等紀錄；持有中另比對已持有大類 續抱／減碼／出場，改變的面向附現在數字）；回答沒交代時 `ensureRatingChangeExplained()` 補程式說明 | `RATING_CHANGE_TITLE`、`RATING_CHANGE_APPENDIX_TITLE`、ask.ts `RATING_CHANGE_MAX`＝15 | ask.ts（個股題、關注清單／持股題、全市場名單） |
| 持有中持有建議逐字一致 | `guardHeldAnswer()`（ratingConsistencyGuard.ts：讀【持股評等彙整】或評等行『已持有』，改寫矛盾動作／混寫／虧損寫獲利吐回，沒寫就補一行）；彙整賺賠 `holdingPnlTag()`（holdingRating.ts）；停利標籤 `takeProfitHoldingLabel()`（siteRating.ts，單一動作） | `HELD_LABEL_APPENDIX_TITLE` | ask.ts postProcessAiAnswer（評測共用） |
| 模型標示 | `modelInfo()`（modelName.ts） | — | AI 問答回答、今日建議、快報、AI 判斷層（紀錄 ai.model）、回饋（前端帶回 model）、/scoreboard 各模型區塊 |
| Gemini 配額 | `premiumCallAllowed()`（gemini.ts） | 每模型每天 18 次、依用途優先序（今日建議＞快報＞AI 判斷） | 所有走非 lite 模型的呼叫（premium 與 standard 退到非 lite 時都經同一個計數） |
| 個股結論卡（買賣判斷題）、比較題程式結論 | `describeDecisionCard()`、`pickForComparison()`（decisionCard.ts，讀 getStockRating 同一份評等；已持有用 describeRatingForHolding 的結果） | `DECISION_CARD_TITLE`、`COMPARISON_PICK_TITLE` | ask.ts（grounding/stock.ts `decisionCard` 選項） |
| 顯示用股名（去「*」標記） | `stripNameMarker()`／`stripNameMarkersInText()`（fuzzyName.ts） | — | describeSiteRating、個股資料、結論卡、回答後處理 |
| 回答後檢查 | `finalizeAiAnswer()`→`postProcessAiAnswer()`（ask.ts，評測 run.ts 共用，含重生 `regenerateTurns()`）；`answerCardIssues()`（decisionCard.ts：第一句與結論卡一致、建議買進禁等回檔字眼、比較題每檔講到自己的結論、截斷）；`guardAnswerNumbers()`（numberGuard.ts）；`guardAvoidPriceAdvice()`（ratingConsistencyGuard.ts）；`normalizeZhTw()`（provider.ts 內建，所有 AI 呼叫） | — | 見第 5 節矩陣 |

## 3. 快取一覽（key、TTL、版本）

| 快取 | key | TTL | 版本史／備註 |
|---|---|---|---|
| 個股評等 | `stock-rating:v5:{代號}:{台北日期}` | 10 分（失敗 60 秒） | 不含市場（避免同一檔有無市場各算一份）；改評等規則或 StockRatingResult 欄位要升版 |
| 今日建議程式名單層 | `action-list:v5:{台北日期}:{today｜next-open}` | 10 分 | 名單、結論、價位、操作計畫、每檔程式風險原句 riskNote（v4：卡片「風險」優先用評等的具體短線風險，不用 AI 的泛用句；v5：KD 改券商遞迴算法）；跟評等各自 10 分鐘，最壞相差一個 TTL（見第 6 節 P-2） |
| 今日建議上一份名單存檔 | `action-list-last:v1:{資料已定時段代號}` | 62 小時 | 平日 22:00～隔天 08:30、週末同一代號（上一個交易日）；只存輸入完整那次的名單評等；重算時上一份名單的股票只有被重新評等為不建議買進才換掉（`actionStability.ts`）。輸入不完整（`degradedReasons`）的名單只快取 1 分鐘、不存檔 |
| 今日建議 AI 解說層 | `action-brief-ai:v3:{台北日期}:{模式}:{時點}`＋`…:latest` | 時點值 36 小時、latest 7 天 | 名單或評等字樣變動的股票不沿用舊解說；不跨日 |
| 今日快報 | `daily-brief:v10:{時點}`＋latest | 同上 | 存檔 `brief-archive:v1:{日期}` 400 天 |
| AI 判斷層 | `ai-judge:v1:{日期}:{代號}` | 30 小時；失敗冷卻 30 分 | 每天最多 10 次呼叫 |
| 加權指數日K | `learning:taiex:6m:{台北日期}` | 1 小時（失敗 60 秒） | 市況與弱市況提示共用 |
| 評等紀錄 | `rating-log:v1:{日期}` hash，field `{代號}#{結論}` | 400 天 | HSETNX：同日同結論只記第一次 |
| 評等翻轉確認狀態 | `rating-confirm:v1` hash，field＝代號，{cur, base} | 30 天 | 同實例同日同檔 base 放記憶體；狀態沒變不寫；fail open＝不確認 |
| 學習紀錄 | `learning:v1:eval:{日期}`、`learning:v1:*` 彙總 | 400 天；讀取記憶體 10 分 | |
| 模型統計 | `ai-model-stats:v1:{日期}` | — | 回饋與使用次數 |
| AI 模擬投資組合 | `sim-portfolio:v1:state`（單一 JSON：現金、持股、近期交易 400 筆（完整的在封存）、每日淨值、檢討 20 篇、盤後定價委託、冪等時點）＋鎖 `sim-portfolio:v1:lock` 240 秒 | 永久 | 執行一次約 3～4 個 Redis 指令；頁面讀取每個執行個體記憶體 60 秒。要重置就把 key 升版 |
| 模擬組合檢討 | `learning:v1:sim-review:{日期}` | 永久 | 含程式整理的事實（facts）與 AI 文字 |
| 模擬組合永久封存 | `sim-portfolio:v1:trades:{YYYY-MM}`（list，每筆交易含未成交＋評等快照＋盤口）、`…:decisions:{YYYY-MM}`（list，每時點決策與選／不選原因）、`…:daily:{YYYY-MM}`（hash，每日淨值＋持股快照） | 永久 | 每時點 1 個 pipeline 寫入；讀取 `/api/sim-portfolio/archive`、`scripts/check-sim-portfolio.py`、/portfolio「完整紀錄」 |
| 回饋 | `ask-feedback:v1`（list） | — | 含 model（AI 回覆回饋）、rating=site（全網站回報） |

## 4. 入口 × 使用的來源矩陣

| 入口 | 評等 | 價位 | 持股成本 | 時段立場 | 弱市況 | 相似案例／教訓 | AI 判斷層 | 評等紀錄 source |
|---|---|---|---|---|---|---|---|---|
| AI 問答個股題 | getStockRating | 評等的 framework | 有持股就帶 costBasis＋buyDate | stanceLine | 評等 reason/marketNote | ✓（experienceText） | 1～2 檔時寫紀錄（不顯示） | `ai-ask` |
| 個股頁「問AI關於」 | 同上 | 同上 | 同上 | 同上 | 同上 | ✓ | 同上 | `stock-button` |
| 關注清單深度分析 | rateHoldings＋buildStockGrounding（前 12 檔） | 同上 | ✓ | ✓ | ✓ | ✓（前 12 檔） | ✗ | `ai-ask` |
| 持股輕量清單（賣哪些） | rateHoldings | 持有中出場參考 | ✓ | ✓ | ✓ | ✗ | ✗ | `ai-ask` |
| AI 問答全市場推薦 | 今日建議名單代號＋即時 getStockRatings＋describeSiteRating | 評等行內 | ✗ | ✓ | ✓ | ✗ | ✗ | `ai-ask` |
| 技術篩選 | getStockRatings | 評等行內 | ✗ | ✓ | ✓ | ✗ | ✗ | `tech-screen` |
| 今日建議／明日操作建議 | getStockRatings（前 8 檔合格候選）＋不建議追驗證 | buildPlan（評等價位） | ✗ | getTradingStance | 頁首 marketNote | ✗（見 P-5） | 時點批次寫紀錄（不顯示） | `today-brief` |
| 今日快報 | ✗（不做個股結論） | ✗ | ✗ | ✗（自有時點） | ✗ | ✗ | ✗ | — |
| /scoreboard | 讀學習彙總 | — | — | — | — | — | 冠軍／挑戰者 | — |
| 回測 | computeRatingCore（同一核心） | 同一核心 | — | — | 門檻同一常數 | — | — | — |

## 5. 回答後檢查矩陣

> AI 問答後處理（`postProcessAiAnswer`）末端另有三個「補程式說明」（第三個 `ensureConfidenceMentioned`：把握程度，confidenceMention.ts）：`ensureRatingChangeExplained`（評等跟前一交易日不同）與 `ensureMarginSignalMentioned`（個股資料有「融資融券組合判讀」【訊號】、回答提到該檔卻沒講出訊號名稱，marginSignal.ts）；評測走同一路徑。

| AI 入口 | 繁中正規化 | 清內部標記 | 去評等標籤 | numberGuard（價位抄錯） | 先不要買刪價位 | 結構化輸出 |
|---|---|---|---|---|---|---|
| AI 問答（含持股、問AI關於） | ✓ | ✓ | ✓ | ✓ | ✓ | 結論卡＋回答後檢查不過時同模型重生一次、仍不過用程式版（模型標示「本站程式版」） |
| 今日建議／明日操作建議 | ✓ | — | — | ✓（AI 只回 JSON 解說，價位由程式寫） | 不需要（先不要買不顯示價位） | JSON |
| 今日快報 | ✓ | — | — | ✗（見 P-4） | ✗ | — |
| 模擬組合每日檢討 | ✓ | — | — | ✗（只寫檢討、不給價位建議；事實由程式整理，AI 失敗用程式版） | — | — |
| AI 判斷層 | ✓ | — | — | — | — | JSON，調整幅度程式夾在 ±1 級 |
| 新聞分類 | 關閉（純分類） | — | — | — | — | JSON |

## 6. 一致性稽核結果（2026-10-06）

### 已修（結構性保證＋整合測試守門）

| # | 嚴重度 | 問題 | 修法 | commit |
|---|---|---|---|---|
| F-1 | 高 | 今日建議 slotCached 後名單／價位可比個股評等舊數小時、甚至跨日 | 拆兩層：名單即時（10 分）、AI 解說依時點（不跨日、名單變動不沿用） | `f4f4d9f`（今日建議排程 agent） |
| F-2 | 高 | 「不建議追」用候選股自己的支持數挑，可能點名評等其實是建議買進的股票（今日建議說不要追、問 AI 卻說建議買進） | 挑中後用 getStockRating 驗證，是建議買進就換下一檔；支持數改用評等的 | `cd91895` |
| F-3 | 中 | 今日建議體檢表的五面向／支持數是另算的（漲幅榜候選沒有技術訊號＝技術面無資料），跟同一份參考資料裡評等行的支持數不同 | 已評等的候選股，體檢表改用評等那份五面向 | `cd91895` |
| F-4 | 中 | 「資料→結論」組裝有 5 份（stockRating＋4 支回測），回測量到的可能不是正式評等 | 抽成 ratingCore.ts 唯一核心；3,777 組輸入舊新逐值相同；守門測試禁止別處呼叫 computeSiteRating／computePriceFramework | `8c2ced0`、`a822292` |
| F-5 | 中 | AI 問答全市場推薦自拼評等行（缺價位與改判條件），且用今日建議快取裡的舊字樣 | 名單代號沿用今日建議，評等行一律即時 getStockRatings＋describeSiteRating | `b9ca0ec` |
| F-6 | 低 | 評等失敗時個股資料的備援價位用 1 年日K，評等用 3 個月，恢復後價位會變 | 備援改用 ratingPriceFramework（同規則、同日K） | `8c2ced0` |
| F-7 | 低 | 開收盤時刻在 marketStatus 與 pollingSchedule 各寫一份（9:00、13:30、15:00、8:30） | marketStatus.ts MARKET_SESSIONS 唯一定義，pollingSchedule 引用；時段一致性測試一週每 5 分鐘 | `db43354` |
| F-8 | 低 | 評等紀錄 field `代號#結論` 在 4 個檔案手拼 | ratingLogKey／ratingLogField；守門測試 | `38311a1`（ratingChange 由作者 `e3460bd` 跟進） |
| F-9 | 低 | 回測市況門檻 5 寫死兩份 | import WEAK_MARKET_RET60_PCT | `8c2ced0` |
| F-10 | 低 | ask.ts 自己算台北日期 | 改用 taipeiDayKey | `b9ca0ec` |

### 待協調／待決定

| # | 嚴重度 | 問題 | 建議 |
|---|---|---|---|
| P-1 | 中 | 國定假日：getTwTradingPhase、tradingStance「下一個交易日」、aiSchedule 都只看週一～五（同一個假設，至少彼此一致），連假時會說「明天開盤」 | 需要時新增一份 `twHolidays.ts` 純資料（每年證交所公告），三處都讀它；要使用者決定是否值得每年維護 |
| P-2 | 低 | 今日建議名單層與個股評等是兩個各 10 分鐘的快取，最壞可能相差一個 TTL（名單建好後評等先刷新） | 名單層在回應時對名單代號重讀 getStockRatings（快取命中、不多打上游）覆寫 label／plan；或名單層 TTL 改短。交今日建議 agent 評估 |
| P-3 | 低 | 持股入口（輕量／深度）寫評等紀錄 source 都是 `ai-ask`，看板分不出持股入口 | 新增 `holdings` source（RatingSource＋RATING_SOURCE_LABEL＋check-rating-log.py），需確認看板與 python 腳本一起改 |
| P-4 | 低 | 今日快報沒有 numberGuard（快報不做個股評等，但會寫個股漲跌與價位） | 快報 AI 輸出後套 guardAnswerNumbers(text, grounding)；brief.ts 由排程 agent 負責，交其評估 |
| P-5 | 低 | 今日建議 AI 解說沒帶相似案例／教訓（個股資料與 AI 判斷層有） | 若要帶，名單每檔附 describeExperience 的一行；會加長提示詞，先跑評測比較再決定 |
| P-6 | 低 | 回測與正式站的刻意差異：回測沒有本益比／財報／持股結構／重訊（3 面向無資料）、追高指標用完整歷史 | 已寫在 ratingCore.ts 與 wide.ts 報告；屬資料限制，非程式不一致 |
| P-7 | 低 | 今日建議／快報卡片沒有 👍👎 回饋，模型表現比較只來自 AI 問答 | 若要比較撰稿模型，卡片加同一個 AnswerFeedback（帶 model） |

## 7. 模組介面型別（摘要）

- `StockRatingResult`（stockRating.ts）：`{ symbol, market, name, price, rating: SiteRating, facets: Facet[], framework: PriceFramework|null, features?: RatingFeatures, regime?: MarketRegime|null, computedAt }`——所有入口拿到的評等物件。
- `SiteRating`（siteRating.ts）：`{ code: "buy"|"avoid"（"buy-on-pullback" 只在舊紀錄）, label, holdingCode, holdingLabel, reason, supportCount, againstCount, zone, noChase, exit, chaseHits, riskNote, pullbackAdd?, marketNote?, upgradeCondition? }`。
- `RatingCoreInput／RatingCoreResult`（ratingCore.ts）：正式站與回測共用的純函式介面。
- `HoldingRatingEntry`（holdingRating.ts）：`{ name, symbol, text, rating, held }`。
- `ActionBriefPick`（actionPicks.ts）：`{ symbol, name, label, code, holdingLabel, reason, plan?, aiView? }`——卡片顯示；AI 問答只取 symbol，評等行即時重讀。
- `RatingLogEntry`（ratingLog.ts）：`{ at, day, session, symbol, name, market, price, code, label, holdingLabel, reason, facets, zone, noChase, exit, chaseHits, source, feat?, rg?, ai? }`。
- `EvalRecord`（learning/types.ts）：`{ at, day, sym, name, code, price, rg, bases, f?, sk, o: {"1"|"5"|"20": HorizonOutcome}, ai? }`，由 `ratingLogToEval()` 對應；check-rating-log.py 讀 RatingLogEntry 的 `at／day／symbol／market／price／code／chaseHits`。
- `TradingStance`（tradingStance.ts）：`{ phase, briefMode, briefTitle, nextOpenLabel, stanceLine }`。

## 8. 改動檢查清單

1. 改評等規則／門檻／價位框架：改 siteRating.ts／priceLevels.ts／ratingCore.ts → `stock-rating` key 升版 → 跑 `npm test`（整合測試）→ 用 scripts/backtest 擴大樣本＋樣本外比較 → 更新 CLAUDE.md 評等基準。
2. 改評等物件欄位：同步 RatingLogEntry（buildRatingLogEntry）、ratingLogToEval、check-rating-log.py、/scoreboard、整合測試的「舊紀錄相容」案例。
3. 改時段：只改 marketStatus.ts／pollingSchedule.ts／tradingStance.ts，整合測試的一週掃描會抓不一致。
4. 新增 AI 入口：用 `callAiProviders`（自動繁中正規化＋模型標示＋Gemini 配額）；回答有價位就套 `guardAnswerNumbers`；有個股結論就讀 `getStockRating`＋`describeSiteRating`，不可自己判斷買賣；把入口加進第 4、5 節矩陣與 consistency.ts。
