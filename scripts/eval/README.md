# AI 問答跨模型評測（eval）

> 理念：AI 能力的下限取決於模型，上限在於我們——把要求、提示詞、流程定義得更好，讓不同模型（包含較弱的免費模型）都有好品質。
> **每次改提示詞（askSystemPrompt.ts／askSystemCompose.ts）、改參考資料格式（grounding/）、改回答後檢查，或換模型／換供應商順序之前與之後，都要跑一次**，比較前後報告。

## 檔案

| 檔案 | 內容 |
|---|---|
| `casesOpen.ts` | 開放／一般題題組（大盤看法、概念篩選、名詞常識、有上文時換題；2026-10-07）。JSON 的 captures[].route 記錄每題組了哪些資料區塊與 RULE_* 規則 |
| `cases.ts` | 題庫（純資料）。每題＝問題＋（可選）對話紀錄／持股／個股頁按鈕代號／假時鐘＋題目專屬檢查 |
| `types.ts` | 題目與檢查的型別（`CheckSpec` 列出所有可用的檢查種類） |
| `graders.ts` | 程式評分器（純函式，測試在 `src/__tests__/evalGraders.test.ts`） |
| `run.ts` | 執行器：組參考資料 → 同一份輸入強制送給各模型 → 後處理 → 評分 → 輸出報告 |
| `report.ts` | 產生 Markdown 報告 |
| `docs/eval/YYYY-MM-DD.md` | 報告（提交進 repo）；同名 `.json` 是完整原始回答（不提交） |

## 怎麼跑

```bash
npx tsx scripts/eval/run.ts                         # 全部題目 × gemini／nvidia／groq
npx tsx scripts/eval/run.ts --only buy-twse,compare-tw   # 只跑幾題（改某條規則時先跑相關題）
npx tsx scripts/eval/run.ts --variants gemini,nvidia      # 指定模型組
npx tsx scripts/eval/run.ts --variants gemini:gemini-3.5-flash-lite   # 直接指定某個 Gemini 模型
npx tsx scripts/eval/run.ts --judge                 # 另加 LLM 評審（1～5 分，輔助參考）
npx tsx scripts/eval/run.ts --judge --judge-with nvidia   # 評審全部交給 NVIDIA（省 Gemini 額度）
npx tsx scripts/eval/run.ts --no-aux-ai             # 組參考資料時擋下 AI 判斷層等輔助呼叫（省額度；改前改後設定要相同）
npx tsx scripts/eval/run.ts --gemini-auto           # Gemini 用正式流程的自動挑選（預設固定 lite，原因見 run.ts）
npx tsx scripts/eval/run.ts --out 2026-10-05-before # 自訂輸出檔名（改動前後各跑一次方便比較）
npx tsx scripts/eval/run.ts --tag open              # 只跑開放／一般題題組（casesOpen.ts；題型路由改動後必跑）
npx tsx scripts/eval/run.ts --exclude-tag open      # 既有整套（不含開放題）
```

- 金鑰只從 `.env.local` 讀（GEMINI_API_KEY／NVIDIA_API_KEY／GROQ_API_KEY），不會印出；全部免費額度，**不會呼叫付費的 Claude**（forceProvider 只會打指定那一家）。
- 全部 30 題約 30～50 分鐘（瓶頸是每題組參考資料約 20～40 秒、NVIDIA 回答 10～40 秒）。題目間隔 6 秒、429／503／逾時退避 30 秒、65 秒各重試一次。
- 會呼叫證交所／櫃買等上游抓資料（跟正式站一樣），短時間不要重複跑整套，避免被限流。
- 沒有 Redis 時評等紀錄、快取都只在記憶體，不會寫到正式站資料。

## 運作方式（為什麼公平）

1. 用正式的 `answerQuestion()` 跑一次，`provider.ts` 的評測攔截鉤子（`setAiEvalInterceptor`）在呼叫 AI 前截下**系統提示詞＋對話＋參考資料**，不呼叫模型。
2. 同一份輸入用 `forceProvider` 分別送給每個模型（不備援、不看熔斷），所以各模型面對的資料一字不差。
3. 套用與 `ask.ts` 相同的回答後處理（繁中把關→清內部標記→拿掉評等標籤→關鍵價位更正），評分看「使用者實際看到的回答」；但「繁中」「內部標記」「關鍵價位照抄」三條看**模型原始輸出**——量的是模型本身守不守規則，而不是後處理有沒有幫它補救。
4. Groq 免費層每模型每分鐘 8,000 token，個股題（約 1 萬 token）會被 `canHandle` 擋下、記為「請求太大，未送出」——這就是正式站實際狀況。

## 怎麼新增題目

1. 從使用者回報（`py scripts/check-feedback.py`）或新規則挑一個「曾經答錯／怕答錯」的情境。
2. 在 `cases.ts` 加一筆：`id`（英文短名）、`title`（測什麼）、`question`、`source`（回報日期或規則名），需要時加 `history`／`holdings`／`contextSymbol`／`clock`（假時鐘，例如 `"2026-10-05T10:30:00+08:00"` 測盤中立場）。
3. `checks` 選現成的檢查種類（見 `types.ts` 的 `CheckSpec`）：`ratingFirst`（第一句照抄評等）、`ratingEach`、`picksOne`、`onlySymbols`、`onlyRatedSymbols`、`require`／`forbid`（正規表示式）、`length`、`yesNoDirect`、`holdingVerdicts`、`sellListMatches`、`noStopLossUnheld`。通用檢查（繁中、英文句、內部標記、開場白、關鍵價位、代號不編造、教訓帶數字、時段措辭）每題自動套用，不用寫。
4. 現成檢查不夠用時，在 `graders.ts` 加一種 `CheckSpec`＋對應的純函式，並在 `evalGraders.test.ts` 補測試。
5. 先 `--only 新題id` 跑一次，確認檢查判得對（看報告的失敗明細，誤判就修檢查，不要遷就模型）。

## 怎麼解讀報告

- **總覽**：各模型「有回答」比例（沒回答＝額度、逾時、請求太大）、規則通過率、全部通過的題數、平均延遲。
- **各規則通過率**（失敗多的排前面）：某條規則**所有模型都常失敗** → 多半是提示詞寫法或資料格式的問題（我們的上限），優先改；**只有某個模型失敗** → 模型能力問題，考慮改成程式後檢查／程式直接決定，讓弱模型也不會錯。
- **失敗明細**：每條失敗附回答開頭，先確認是真的錯還是檢查誤判（誤判要修 graders）。
- 時間有關的規則（盤中不說收盤、週末不說今天）依「組參考資料當下的時段」判斷；評測跑的時段不同，套用的通用規則也不同，比較前後報告時盡量在同一個時段跑，或看有假時鐘的題目。
- 報價會跳動，同一題兩次跑的評等可能不同；檢查都是「回答與當次參考資料是否一致」，不受影響。

## 跨入口一致性（consistency.ts，2026-10-06）

`npx tsx scripts/eval/consistency.ts --symbols 2330,3044 [--cost 2330=900]`：同一檔經「AI 問答個股題／問AI關於／關注清單深度分析／今日建議程式名單」組出的參考資料，【本站綜合評等】那一行必須逐字相同；持有中（帶成本）的個股題與「賣哪些」清單，已持有結論必須相同。純程式比對：攔截鉤子擋下所有 AI 呼叫、不讀 `.env.local`（不寫正式站 Redis、零額度）。有任何不一致時結束碼 1。改評等、價位、持股、今日建議或問答資料組裝之後跑一次（另有 vitest 版：`src/__tests__/crossEntryConsistency.test.ts`，用 mock 資料每次 `npm test` 都跑）。
