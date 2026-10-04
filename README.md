# 股情雷達 StockRadar

私人股票研究工具：即時查詢台股（上市/上櫃/興櫃）與美股報價、互動走勢圖表、篩選排行、關注清單損益試算，並提供 AI 問答直接給個人看法與具體操作建議。

用 Next.js (App Router) + TypeScript + Tailwind CSS 打造，圖表使用 [lightweight-charts](https://github.com/tradingview/lightweight-charts)。

> **這不是公開 Demo，是有密碼保護的私人工具**（見下方「存取限制」），只有知道密碼的人（開發者跟家人）能用。這一點很重要：AI 問答會直接給「建議買進/賣出」「這檔目前偏多/偏空」這類具體個人看法與價位建議，這種內容如果對不特定多數人公開，在台灣屬於《證券投資顧問事業管理規則》規範的業務；靠密碼把使用者限定在少數已知的人，才是這個網站能這樣設計 AI 問答的前提。**如果之後把密碼保護拿掉、或網站變成任何人都能進來，AI 問答的系統提示詞（`src/lib/ai/ask.ts`）務必要改回客觀數據描述、不給具體買賣建議的版本。**

## 存取限制

`src/proxy.ts`（Next.js 16 的 middleware）攔截所有頁面與大多數 API 路由：沒有 `site_unlocked` cookie 一律導去 `/unlock` 輸入密碼。密碼比對邏輯在 `src/app/api/unlock/route.ts`：

```ts
const SITE_PASSWORD = process.env.SITE_PASSWORD || "1118";
```

正式站建議在 Vercel 環境變數設定 `SITE_PASSWORD` 覆蓋掉這個預設值；沒設定的話就是字面值 `"1118"`（本 repo 目前是**私人 repo**，所以這個字面值不會被公開讀到，但仍建議設定成真正的密鑰）。Vercel Cron 與 GitHub Actions 觸發的 `api/cron/*` 路由被排除在密碼閘門外（各自用自己的 `CRON_SECRET` 驗證）。

## 功能

- **首頁**：AI 每日市場快報、AI「今日建議」（多面向整合技術面/籌碼面/基本面/財報面/消息面，明確給買進候選與「漲很多但不建議追」的反例）、我的關注清單、大盤指數（台股／美股分頁，含台指期夜盤近月合約）、焦點排行（台股／美股分頁）。
- **個股頁** `/stock/[symbol]`：即時（或近即時）報價、基本面（本益比/殖利率/股價淨值比/市值）、K 線圖（當日分時線 + 1個月/3個月/6個月/1年 K 線，滑鼠 hover 顯示明細）、客觀技術訊號標籤（均線位置/多空排列、RSI、MACD 含 0 軸強弱、KD、布林通道、爆量、連漲跌天數）、籌碼面（三大法人/外資/投信/自營商買賣超、融資融券，僅台股）、重大訊息公告（僅台股）、內外盤（僅台股，資料源見下方）、AI 問答（「問 AI 關於本股」深度分析）、到價提醒、關注清單星號。報價旁顯示交易狀態（盤中／試搓中／已收盤／興櫃議價中），交易時段自動輪詢刷新。
- **搜尋 / 篩選** `/search`：台股、美股分頁切換，可依產業（多選，含本站自行整理的細分產業如 IC 載板/矽光子/記憶體，比官方大分類更細）、股價區間、漲跌幅、成交量、成交金額篩選與排序，另有「價量關係」偏多/偏空推論篩選。
- **每日焦點榜單** `/highlights`：漲幅榜／跌幅榜／成交量榜／技術訊號共振股，台股、美股分開排名。
- **重大新聞** `/news`：AI 從近期新聞裡挑出「可能影響大盤等級」的消息置頂，其餘一般新聞附全文摘要，無限捲動。
- **我的關注**：預設用瀏覽器 localStorage 儲存自選股，可填入持有股數／購買價格，自動算損益平衡價（已計入台股買賣手續費 0.1425%×2、賣出證交稅 0.3%，捨去到整數元對齊真實券商計費方式）、投資金額、損益金額/百分比；持有股票自動排在最上面並可依投資金額/漲跌幅/損益%/細分產業排序，支援拖曳調整順序、匯出 CSV；設定 Google 登入後可跨裝置同步（見下方「帳號登入」）。
- **AI 問答**：右下角浮動聊天視窗（支援語音輸入），多輪對話記憶，可針對目前瀏覽的個股、任何代碼/公司名、排行榜篩選（技術指標多重條件、本益比/殖利率/股價淨值比、法人買賣超等）提問，也能對關注清單整批做深度分析（持有/未持有分開講、給具體價位建議與理由）。
- **到價提醒**：設定股價到達某個區間時的網頁內提醒（localStorage，尚未接外部通知管道）。
- **深色模式**：右上角手動切換，選擇會記住在瀏覽器；未手動選擇時跟隨系統設定。

## 資料來源與限制（重要）

| 市場 | 即時報價 | 基本面 | 歷史 K 線 | 籌碼面 |
|---|---|---|---|---|
| 台股（上市 TWSE） | `mis.twse.com.tw`（單檔＋批次，非官方但廣泛使用） | TWSE OpenAPI `BWIBBU_ALL`（官方，每日更新） | TWSE `STOCK_DAY`（官方） | TWSE 三大法人(T86)／融資融券(MI_MARGN)（官方） |
| 台股（上櫃 TPEx） | `mis.twse.com.tw` 的 `otc_` 前綴（**跟上市股同一套即時系統**，2026-09 前曾誤用 TPEx 官方 OpenAPI `tpex_mainboard_quotes`，但那個端點其實是「每個交易日更新一次」的盤後資料，已改掉） | TPEx OpenAPI（本益比/殖利率/股價淨值比，官方） | TPEx 網站查詢端點（官方，逐月查詢） | TPEx 官方對應端點 |
| 台股（興櫃 Emerging） | 櫃買中心自己的興櫃即時報價站 `mis.tpex.org.tw`（`Quote.asmx/GETQ20` 單檔／`GETQ30` 全市場） | 櫃買中心 OpenAPI（本益比/殖利率等興櫃**沒有**，依規定不對外公布，見下方限制） | Yahoo Finance `.TWO`（興櫃跟上櫃共用這個後綴） | 興櫃依規定不能融資融券，無此資料 |
| 台指期夜盤（近月合約） | TAIFEX 官方看盤網站 `mis.taifex.com.tw/futures/`（非正式文件化 API，見 `src/lib/data/taifex.ts` 開頭研究記錄） | — | — | — |
| 美股 | Yahoo Finance `chart` + `v7/finance/quote`（批次查詢，非官方） | Yahoo `v7/finance/quote` | Yahoo `chart` | 無公開資料源，美股籌碼面留白 |

以上皆為**無需 API 金鑰的公開端點**，但：

- 屬於非官方或半官方端點，可能隨時變動、被限流或封鎖。實測過對 `mis.twse.com.tw` 併發請求太多（無上限扇出可能有數十個同時連線）會被靜默斷線甚至短暫封鎖來源 IP（不會回 429），全站批次報價因此都有併發上限節流（見 `src/lib/data/twse.ts` 的 `MIS_BATCH_CONCURRENCY`）。
- **本站不使用任何示範／假資料。** 抓取失敗一律誠實顯示「資料暫缺」／「目前無法取得資料」，絕不用亂數或參考價頂替；失敗結果只會被短暫快取（幾秒等級），不會讓一次暫時性的上游失敗拖累到下一個完整快取週期都看不到資料。
- 台股上市/上櫃清單各自有批次抓報價用的檔數上限（目前 TWSE 1200 檔、TPEx 900 檔，已涵蓋官方全部現存上市櫃公司；美股約 171 檔精選跨產業大型股），興櫃（約 360 多檔）只進完整清單供搜尋/個股頁/AI 問答查詢，**不進批次排行榜清單**（興櫃無漲跌幅限制、流動性低，混進「今天漲最多」榜單會天天洗版）。清單以外的極冷門股/興櫃排行查不到是刻意的取捨，個股頁單檔查詢不受此限制。
- 台股成交量單位：原始單位是「張」（1張=1000股），程式已換算成股數以跟歷史 K 線一致；顯示給使用者時再換算回「張」（台股慣例）。
- 「內外盤」（買氣/賣壓）資料來源是 `tw.stock.yahoo.com` 的台灣在地化網頁（非 `query1.finance.yahoo.com` 那個全球 API），只支援單檔查詢，因此只出現在個股頁，不進批次清單/排序。外盤＝買方主動追價（買氣，紅色）、內盤＝賣方主動降價求售（賣壓，綠色）。

## AI 問答設定

AI 問答、每日快報、「今日建議」都以即時/近即時報價與近期走勢作為依據（RAG 概念，非憑空生成數字），支援兩種模型供應商：

| 供應商 | 環境變數 | 費用 | 申請 |
|---|---|---|---|
| Google Gemini（優先使用） | `GEMINI_API_KEY` | 有免費額度，不需信用卡 | https://aistudio.google.com/apikey |
| Anthropic Claude | `ANTHROPIC_API_KEY` | 按量計費 | https://console.anthropic.com |

兩個都設定時會優先呼叫 Gemini，失敗才 fallback 到 Claude。兩個都沒設定時，會回傳「原始資料整理」的罐頭內容（仍附上即時/近即時報價），並提示尚未啟用 AI，網站其餘功能不受影響。

本機開發建立 `.env.local`：
```bash
GEMINI_API_KEY=xxxx
```
部署在 Vercel 則在 Project → Settings → Environment Variables 新增同名變數。

### 每日快報／今日建議／預熱排程

- `vercel.json`：每天觸發一次 `/api/cron/daily-brief`，在當天第一位訪客之前預先生成好快報。
- `.github/workflows/warm-cache.yml`：平日主要時段每 5 分鐘、離峰每 30 分鐘（週末不觸發）呼叫 `/api/cron/warm-cache`，預熱報價/排行/技術指標篩選/今日建議等各項快取，降低 Vercel 用量與訪客等待時間；回應會附上每一項預熱任務的實際結果，排查快取問題時可以直接看這支。
- 可選環境變數 `CRON_SECRET`：設定後，cron 路由只接受帶正確 `Authorization: Bearer <secret>` 的請求；不設定則不驗證。

### AI 回答回饋（👍／👎）

聊天視窗每則 AI 回答下方有 👍／👎（👎 可選填原因），使用者真的按了才會 POST `/api/ask-feedback`，寫進 Redis list `ask-feedback:v1`（LPUSH＋LTRIM 只留最近 300 筆，每次回饋 1 次 pipeline、2 個指令；問答本身不寫任何東西）。開發者查看：登入後（或帶 `site_unlocked=granted` cookie）`GET /api/ask-feedback?limit=50&rating=down`，回傳新到舊的 JSON。沒設 Redis 時 POST 安靜略過、GET 回空陣列。

### 共用快取（Redis，選用但正式站已設定）

`src/lib/data/cache.ts` 的 `cached()`／`cachedMap()` 等函式優先用共用的 Redis（`src/lib/data/kv.ts`），沒設定則自動退回單一 Serverless 執行個體自己的記憶體內快取。正式站目前已設定 Upstash Redis 免費方案。

| 方式 | 環境變數 |
|---|---|
| Vercel Marketplace「Redis」整合 | `KV_REST_API_URL`、`KV_REST_API_TOKEN` |
| 直接連接 Upstash Redis（[upstash.com](https://upstash.com) 免費額度即可） | `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN` |

任何一個 Redis 讀寫失敗都會自動退回即時重新抓資料，不會讓頁面壞掉。

## 帳號登入（選用，Google 一鍵登入）

預設不需要登入即可使用全部功能（自選股存在瀏覽器 localStorage）。設定好下面三個環境變數後，右上角會出現「使用 Google 登入」按鈕，登入後自選股會同步到帳號，換裝置/換瀏覽器登入同一個 Google 帳號就能看到同一份清單。三個變數只要有一個沒設定，登入按鈕就不會顯示，網站其餘功能完全不受影響。

1. 到 [Google Cloud Console → API 憑證](https://console.cloud.google.com/apis/credentials) 建立一組 **OAuth 用戶端 ID**（應用程式類型選「網頁應用程式」），「已授權的重新導向 URI」填：
   - 正式站：`https://你的網域/api/auth/callback/google`
   - 本機開發：`http://localhost:3000/api/auth/callback/google`
2. 把取得的用戶端 ID / 密碼填進環境變數：`AUTH_GOOGLE_ID`、`AUTH_GOOGLE_SECRET`
3. `AUTH_SECRET`：任意隨機字串（可用 `npx auth secret` 產生），用來加密登入 session

**跨裝置同步需要「共用快取」章節提到的 Redis** 來存放每個帳號的自選股清單；只設定登入、沒設定 Redis 的話，登入功能本身仍然正常，但自選股不會真的跨裝置同步（`/api/watchlist` 會回報 `syncAvailable: false`）。首次登入時，會把「這台裝置當下的本機清單」與「帳號裡已同步的清單」取聯集合併，之後每次加入/移除都會即時推上雲端。

## 開發

```bash
npm install
npm run dev
```

開啟 http://localhost:3000

```bash
npm run lint    # ESLint
npm run build   # 正式版建置
```

## 專案結構（重點檔案，不是全部）

```
src/
  app/
    page.tsx / action/ / stock/[symbol]/ / search/ / highlights/ / news/ / unlock/
    api/
      quote/[symbol]/ chart/[symbol]/ search/ sectors/ indices/ taifex-futures/
      symbol-lookup/ momentum/ ask/ daily-brief/ action-brief/ news-feed/
      watchlist/ auth/[...nextauth]/ unlock/ cron/{daily-brief,warm-cache,backfill-volume-history}/
  proxy.ts                  全站密碼保護閘門（Next.js 16 middleware）
  components/               UI 元件（StockChart、ChatWidget、WatchlistTable、TaifexFuturesCard 等）
  lib/
    data/                   資料層——所有股票資料的唯一進出口
      index.ts               純 barrel，只做 re-export，實際邏輯在下面各檔
      twse.ts / tpex.ts / emerging.ts / us.ts / taifex.ts   各市場資料抓取
      universe.ts             股票清單（TWSE/TPEx/興櫃官方清單 + 美股精選清單）
      symbols.ts / quote.ts / chart.ts / marketIndices.ts / search.ts / companyData.ts
      momentum.ts / techScreen.ts / volumeSurge.ts / valueScreen.ts / chipsRanking.ts
      cache.ts / degradedCache.ts / kv.ts   共用 TTL 快取（Redis 優先、記憶體備援）
      news.ts / articleExtract.ts   新聞抓取與全文摘要
    ai/                     AI 問答與每日快報／今日建議生成
      ask.ts                  /api/ask 主要進入點；intent.ts/symbolResolve.ts/grounding/*.ts
                               各自負責意圖判斷與各面向資料組裝
      brief.ts / actionBrief.ts   每日快報／今日建議
      provider.ts / gemini.ts     Gemini→Claude fallback 呼叫邏輯
    portfolio.ts              關注清單損益平衡價/投資金額/損益公式（唯一真實來源）
    watchlist.ts / watchlistStore.ts   自選股（localStorage / 登入後 Redis）
    fineIndustry.ts           本站自行整理的細分產業分類（非官方）
    signals.ts                客觀技術訊號計算
    marketStatus.ts / pollingSchedule.ts   交易時段判斷與各市場輪詢節奏
    priceAlerts.ts            到價提醒（localStorage）
```

## 設計慣例

- 依台灣／中文市場慣例：**紅色＝上漲、綠色＝下跌**（與美股常見的紅跌綠漲相反）。
- 淺色／深色模式皆已設計對應色票，並通過色盲友善（CVD）對比驗證；漲跌同時搭配 ▲／▼ 圖示與正負號，不僅依賴顏色辨識。
- 任何同時涉及台股與美股的畫面，一律用分頁（MarketTabs）切換顯示單一市場，不並排顯示兩個市場，避免混淆。
- 抓不到真實資料時一律誠實顯示「資料暫缺」／「無法取得」，絕不用假資料或參考價頂替；這條原則優先於畫面好不好看。

## 免責聲明

本站所有資訊（含公開資料整理與 AI 生成內容）僅供研究參考，不構成正式投資建議，使用者需自行判斷風險。AI 問答提供的具體看法與價位建議，是在「僅限已知密碼的少數使用者」這個存取限制前提下設計的（見上方「存取限制」），不適用於對外公開的一般用途。
