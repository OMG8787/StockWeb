# PROGRESS.md — 專案現況與工作日誌

> **給接手這個專案的 Claude Code：** 這份文件是為了讓你在完全沒有先前對話紀錄的情況下，
> 也能看懂這個 repo 每個資料夾/檔案在幹嘛、目前做到哪、之前修過什麼問題。
> 每次修改完程式碼準備回覆使用者之前，**先讀這份文件掌握現況，回覆前再照 CLAUDE.md
> 的規定更新這份文件並 push**（見下方「跨裝置接續規則」）。

## 這是什麼專案

**股情雷達 StockRadar**——台股／美股股票研究網站。即時查詢報價、互動 K 線圖、篩選排行、
AI 問答。Next.js (App Router) + TypeScript + Tailwind CSS，圖表用
[lightweight-charts](https://github.com/tradingview/lightweight-charts)。

**2026-09-11 起改為私人／家人使用**（見下方工作日誌）：網站現在有進入密碼保護
（`src/proxy.ts` + `/unlock`），不再是對外公開服務；AI 問答也因此改成會直接給明確的
個人看法/推薦，不再強制客觀中立、不再附加免責聲明——**這個決定的前提是「網站已經真的做了
存取限制」，如果之後又要把網站改回公開，AI 問答的系統提示詞（`lib/ai/ask.ts`）務必要
改回客觀描述、不做買賣建議的版本，順序不能顛倒。**

- **正式站**：https://stock-web-blond.vercel.app（進入密碼預設寫在 `src/app/api/unlock/route.ts`，或看有沒有設定 `SITE_PASSWORD` 環境變數蓋掉它）
- **GitHub**：hj110b13-Andy/Stock-web
- **開發分支**：`claude/relaxed-curie-c69kp0`（所有工作都在這個分支上，push 上去 Vercel 會自動部署）
- **功能完整說明、環境變數設定、資料來源限制**：見 `README.md`，這份文件不重複列，只補「檔案功能地圖」跟「工作日誌」。

## 資料夾與檔案功能地圖

```
src/
├─ app/                              Next.js App Router 頁面與 API
│  ├─ page.tsx                       首頁：大盤指數、AI 每日快報、焦點排行、我的關注清單
│  ├─ layout.tsx                     全站 layout；deferred 深色模式偵測 inline script（避免 FOUC）
│  ├─ not-found.tsx                  404 頁
│  ├─ robots.ts / sitemap.ts         SEO：/robots.txt、/sitemap.xml
│  ├─ globals.css                    全站設計 token（CSS 變數）：淺色/深色配色、紅漲綠跌色票
│  ├─ stock/[symbol]/page.tsx        個股頁：報價 + K線 + 技術訊號 + 基本面 + AI問答 + 關注按鈕
│  ├─ search/page.tsx                搜尋/篩選頁（外殼，實際邏輯在 components/SearchClient.tsx）
│  ├─ highlights/page.tsx            每日焦點榜單：漲幅/跌幅/成交量榜 + 技術訊號共振股
│  ├─ news/page.tsx                  重大新聞頁：AI 置頂大消息 + 無限捲動瀏覽近期所有新聞
│  ├─ action/page.tsx                今日建議頁：給沒有股市背景的人看的白話「今天該怎麼做」
│  └─ api/
│     ├─ quote/[symbol]/route.ts     GET 單檔即時報價
│     ├─ chart/[symbol]/route.ts     GET 歷史 K 線（range: 1m/3m/6m/1y）
│     ├─ search/route.ts             GET 篩選/排序股票清單（市場、產業、價格區間、漲跌幅）
│     ├─ sectors/route.ts            GET 指定市場的產業分類選單
│     ├─ indices/route.ts            GET 大盤指數
│     ├─ ask/route.ts                POST AI 問答（支援多輪對話歷史）
│     ├─ daily-brief/route.ts        GET 每日快報，給首頁 DailyBriefCard client-side fetch用，
│     │                              支援 ?refresh=1 強制略過快取重算
│     ├─ news-feed/route.ts          GET 重大新聞分頁用，支援 ?offset=&limit= 分頁、
│     │                              ?refresh=1 強制重算，第一頁才會帶 pinned 陣列
│     ├─ action-brief/route.ts       GET 今日建議，架構同 daily-brief（?refresh=1、
│     │                              client-side fetch）
│     ├─ watchlist/route.ts          GET/PUT 登入後自選股跨裝置同步
│     ├─ auth/[...nextauth]/route.ts NextAuth（Google 登入）
│     ├─ cron/daily-brief/route.ts   Vercel Cron 排程觸發：預先生成當天 AI 快報
│     ├─ cron/warm-cache/route.ts    背景預熱：由 .github/workflows/warm-cache.yml 每 5 分鐘
│     │                              呼叫一次，預先算好 search/highlights/momentum/indices，
│     │                              讓真正訪客幾乎都吃到現成資料
│     └─ momentum/route.ts           GET 技術訊號共振股（給 highlights 頁的 client-side fetch用）
│
├─ components/                       UI 元件（React, 'use client' 除非明確是 server component）
│  ├─ StockChart.tsx                 K 線圖 + 成交量（lightweight-charts），會讀 CSS 變數換色
│  ├─ ChatWidget.tsx                 右下角 AI 問答浮動視窗，多輪對話
│  ├─ AskAboutButton.tsx             個股頁「問AI關於這檔股票」按鈕，會設定聊天視窗的 grounded symbol
│  ├─ MarketTabs.tsx                 台股/美股分頁切換共用元件（全站涉及雙市場的地方都用它，不並排）
│  ├─ StockTable.tsx                 股票清單表格（排行/搜尋結果共用）
│  ├─ MomentumTable.tsx              技術訊號共振股清單
│  ├─ SearchClient.tsx               搜尋頁的篩選邏輯（產業多選、價格區間、debounce）
│  ├─ SignalTags.tsx                 個股頁技術訊號標籤（爆量/創新高低/均線/連漲跌）
│  ├─ FundamentalsCard.tsx           基本面卡片（本益比/股價淨值比/殖利率/市值）
│  ├─ ChipsRatioSummary.tsx          個股頁報價正下方「籌碼比例」摘要（融資使用率/外資持股/大戶持股＋升降），僅台股，Suspense串流
│  ├─ ChipsCard.tsx                  籌碼面卡片（三大法人買賣超/融資融券）+ 近期重大訊息公告，
│  │                                 僅台股頁面渲染（`quote.market === "TW"` 才顯示），美股
│  │                                 沒有對應的公開資料源
│  ├─ LiveQuoteHeader.tsx            個股頁報價 header，盤中每 20 秒自動刷新
│  ├─ LiveIndices.tsx / IndexCard.tsx 首頁大盤指數卡片，同樣有自動刷新
│  ├─ MarketStatusBadge.tsx          「盤中／已收盤」狀態徽章
│  ├─ DailyBriefCard.tsx             首頁 AI 每日快報卡片，client component 掛載後才 fetch
│  │                                 （避免冷快取當天拖慢首頁），預設收合 220px + 「展開全文」，
│  │                                 不依賴 AI 每次都乖乖控制在系統提示詞要求的字數範圍內
│  ├─ NewsFeedList.tsx               重大新聞頁清單：AI 置頂大消息區塊 + 無限捲動主清單，
│  │                                 IntersectionObserver 觸發載入下一頁
│  ├─ WatchlistButton.tsx            加入/移除關注清單的星號按鈕
│  ├─ WatchlistSection.tsx           首頁「我的關注」清單區塊（排序、匯出 CSV）
│  ├─ WatchlistTable.tsx             關注清單表格（取代 StockTable）：可編輯持有股數/平均成本，
│  │                                 即時算損益，寫入用 useSyncExternalStore 要注意快照函式不能
│  │                                 用 .filter()/.map()（見下方工作日誌無限迴圈那次教訓）
│  ├─ WatchlistSync.tsx              登入後把本機 localStorage 清單與雲端清單合併同步
│  ├─ PriceAlertForm.tsx             個股頁「到價提醒」表單：設定/列出/刪除該股的到價提醒
│  ├─ PriceAlertWatcher.tsx          掛在全站 layout，每 30 秒檢查所有未觸發的到價提醒，
│  │                                 觸發時右下角跳提醒（目前只有網頁內顯示，還沒接 LINE 通知）
│  ├─ MarkdownLite.tsx               輕量 Markdown 渲染（粗體/條列），給 AI 回覆/每日快報用，
│  │                                 不是完整解析器，只處理 AI 實際會用到的語法
│  ├─ ThemeToggle.tsx                深色模式手動切換開關，寫 data-theme + localStorage
│  ├─ SiteHeader.tsx                 全站頂部導覽列（含 ThemeToggle、AuthButton）
│  ├─ AuthButton.tsx                 Google 登入/登出按鈕
│  └─ AuthProvider.tsx               NextAuth SessionProvider 包裝
│
└─ lib/
   ├─ data/                          資料層——所有股票資料的唯一進出口
   │  ├─ index.ts                    **2026-09-21 拆分後只剩47行**：純barrel，只做
   │  │                              re-export，對外的匯出項目（getQuote/getChart/getIndices/
   │  │                              searchStocks/getFundamentals/getEarnings/
   │  │                              getMultiSignalStocks/detectMarket/normalizeSymbol…）逐項
   │  │                              完全不變、呼叫端不用改任何 import。實際邏輯搬到下面幾個
   │  │                              新檔案：
   │  │  ├─ symbols.ts                detectMarket/normalizeSymbol/universeFor/resolveTwExchange
   │  │  ├─ quote.ts                  getQuote/getMarketDepth，報價TTL邏輯
   │  │  ├─ chart.ts                  getChart，分時圖
   │  │  ├─ marketIndices.ts          getIndices/getTaifexNightFutures（大盤指數、台指期夜盤）
   │  │  ├─ twMergedMaps.ts           mergeTwMaps（合併TWSE+TPEx兩份Map的共用邏輯）
   │  │  ├─ companyData.ts            getFundamentals/getEarnings/getChips/getMaterialAnnouncements
   │  │  ├─ marketQuoteMap.ts         全市場批次報價快取（給排行榜/篩選頁用）
   │  │  ├─ search.ts                 SearchFilters/searchStocks
   │  │  ├─ degradedCache.ts          cachedListWithDegradedEmptyTtl/cachedWithDegradedNullTtl
   │  │  │                            （失敗結果只給短命TTL，不讓一次上游失敗污染全站到正常
   │  │  │                            TTL滿——2026-09-21修`/api/indices`漏抓TAIEX時新增的
   │  │  │                            單值版本，陣列版本更早就有）
   │  │  ├─ momentum.ts               getMultiSignalStocks（技術訊號共振股）
   │  │  ├─ techScreen.ts             getTechnicalScreen（多重技術指標篩選，全市場逐檔算）
   │  │  ├─ volumeSurge.ts            getVolumeSurgeStocks（價漲量增+連漲天數）
   │  │  ├─ valueScreen.ts            getValueScreen（全市場本益比/殖利率/股價淨值比排行）
   │  │  ├─ chipsRanking.ts           getChipsRanking（三大法人/外資/投信買賣超排行）
   │  │  ├─ chipsRatios.ts            getChipsRatios（融資使用率/外資持股比例/大戶持股比例＋前一期）
   │  │  ├─ foreignHoldings.ts        外資持股（TWSE MI_QFIIS／TPEx qfii，可查指定日算日增減）
   │  │  ├─ majorHolders.ts           集保股權分散表第15級大戶（週資料；週快照＋官網個股查詢補上一週）
   │  │  └─ volumeBackfill.ts         成交量歷史一次性回填（見volumeHistory.ts）
   │  │                              全部「抓不到資料就回 null，絕不產生假資料」的原則不變
   │  ├─ twse.ts                     台股（上市）資料抓取：TWSE 即時報價/K線/OpenAPI 基本面(含P/B)/月營收/
   │  │                              季報EPS/三大法人買賣超(legacy T86)/融資融券(MI_MARGN)/
   │  │                              每日重大訊息(t187ap04_L，注意「主旨 」欄位名尾端有個空格)；
   │  │                              也 export `TW_INDUSTRY_NAMES`（產業代碼→名稱表）給 tpex.ts 共用
   │  ├─ tpex.ts                     **2026-09-14 新增**：台股（上櫃 TPEx）資料抓取，架構與涵蓋範圍
   │  │                              完全比照 twse.ts（報價/K線/基本面/月營收/季報EPS/三大法人/
   │  │                              融資融券/重大訊息/公司清單），見下方工作日誌詳細說明欄位差異
   │  │                              與 TPEx 端點自身的不穩定性（大檔案偶爾回傳中斷，已加重試）。
   │  ├─ emerging.ts                 **2026-09-20 新增**：台股（興櫃 Emerging）資料抓取——報價來自
   │  │                              櫃買中心自己的興櫃即時報價站 mis.tpex.org.tw 的
   │  │                              Quote.asmx/GETQ20（單檔）/GETQ30（全市場一次），公司清單/月營收/
   │  │                              季報EPS 走 openapi，K線走 Yahoo `.TWO`。**興櫃沒有開盤價/收盤價**
   │  │                              （議價交易），漲跌基準是「前日均價」，也沒有漲跌幅限制——檔案
   │  │                              開頭有完整說明，改這個檔案前務必先讀。興櫃刻意不進排行榜/
   │  │                              篩選頁的批次清單（見 universe.ts 的 capUniverse）。
   │  ├─ taifex.ts                   **2026-09-14 新增**：台指期（TX，大台指）夜盤近月合約報價，
   │  │                              資料源是 TAIFEX 官方免費看盤網站 mis.taifex.com.tw/futures/
   │  │                              自己的 getQuoteList API（不需登入/金鑰），見檔案開頭完整研究
   │  │                              記錄跟下方工作日誌；export `describeTaifexNightFutures()`
   │  │                              給 AI 問答/快報組 grounding 文字共用
   │  │                              興櫃不在這個檔案的範圍內，改看上面的 emerging.ts。
   │  ├─ us.ts                       美股資料抓取：Yahoo Finance 報價/K線/基本面(含P/B)/季度財報（皆需 crumb+cookie 認證）
   │  ├─ news.ts                     新聞資料：Google 新聞 RSS 搜尋（zh-TW + en-US 雙版面，美股
   │  │                              相關查詢會混合中英文來源），給 AI 問答「資訊面」用；
   │  │                              也有 fetchNewsFeedPool()（重大新聞頁用，12 個主題關鍵字
   │  │                              合併去重排序）跟 link/來源標籤解析（見下方工作日誌）
   │  ├─ articleExtract.ts           **2026-09-14 新增**：把 news.ts 給的 Google 新聞 RSS 連結
   │  │                              （本身是 Google 導轉頁、不是真正出版商網址）解回真正的
   │  │                              文章網址並擷取內文全文，給 newsfeed.ts 的一般新聞摘要用
   │  │                              （見下方工作日誌「新聞摘要改抓全文」，含真實擷取成功率）
   │  ├─ universe.ts                 股票清單：台股動態抓 TWSE 官方上市清單＋TPEx 官方上櫃清單
   │  │                              ＋興櫃官方清單並合併（`UniverseEntry.exchange` 內部欄位標記
   │  │                              "TWSE"/"TPEx"/"Emerging"，只用於路由到正確的資料源，不影響
   │  │                              對外的 Market="TW"/"US" 型別；**興櫃只進完整清單、不進
   │  │                              capUniverse 那份批次抓報價的清單**，見該函式註解），
   │  │                              各自分開設批次查報價用的清單上限（**2026-09-15調高後**
   │  │                              TWSE 1200／TPEx 900，見下方工作日誌），美股約 171 檔
   │  │                              精選跨產業大型股種子清單（US_UNIVERSE，`universe.ts`）
   │  ├─ cache.ts                    共用 TTL 快取：cached()/cachedMap()/peekCached()/writeCached()，
   │  │                              Redis 優先、記憶體備援、single-flight 去重複、null 值也會被
   │  │                              正確快取（見工作日誌，這層踩過最多坑）
   │  ├─ volumeHistory.ts            **2026-09-14 新增**：searchStocks()「價量關係」推論（價漲/
   │  │                              跌量增，見下方工作日誌）的成交量歷史記錄+均量計算，piggyback
   │  │                              在既有批次報價快取上、零額外上游請求，收盤後才記錄避免污染
   │  │                              歷史，見檔案內註解跟工作日誌完整說明
   │  ├─ kv.ts                       Redis 連線設定（Vercel KV / Upstash）——**2026-09-11 起正式站
   │  │                              已經設定好並連接（Upstash 免費方案），不再是「選用但沒開」
   │  │                              的狀態；程式碼邏輯仍然保留「沒設定就退回記憶體快取」的容錯，
   │  │                              本機開發沒設這兩個環境變數一樣能跑，只是不會有跨伺服器共用
   │  └─ types.ts                    Market / Quote / Chart 等共用型別，含 SearchItem.volumeTrend/
   │                                 volumeRatio（**2026-09-14 新增**，價量關係推論，非真實買賣單資料）
   │
   ├─ ai/                            AI 問答與每日快報
   │  ├─ providerAdapters.ts / openaiCompat.ts / providerHealth.ts / zhTwNormalize.ts(+zhTwCharMap.ts)
   │  │                              各供應商轉接（Gemini/NVIDIA/Groq/Claude）、OpenAI相容呼叫、
   │  │                              熔斷器、輸出繁中把關（簡體/日文新字體一對一轉繁、成段假名判不合格）
   │  ├─ provider.ts                 共用的 Gemini→NVIDIA→Groq→Claude 備援編排（callAiProviders），
   │  │                              處理對話歷史裁切、開頭必須是 user、合併連續同角色 turn
   │  ├─ ask.ts                      **2026-09-22 再次拆分後約120行**：/api/ask 的主要進入點，
   │  │                              組grounding、組出`system`陣列、呼叫callAiProviders，其餘
   │  │                              職責搬到下面幾個新檔案（public API/呼叫端完全不用改）：
   │  │  ├─ askSystemPrompt.ts        **2026-09-22新增**：系統提示詞裡每一條規則各自獨立成一個
   │  │  │                            具名常數（RULE_NO_FABRICATE、RULE_HOLDINGS_LIGHT…），要改
   │  │  │                            哪條AI行為直接grep常數名稱定位，不用在整段密集中文裡
   │  │  │                            找對地方；ask.ts只是把這些常數依序組回`system`陣列
   │  │  ├─ askTypes.ts               對外型別 AskResult／HoldingInput
   │  │  ├─ symbolResolve.ts          從問句解析股票代號/公司名（guessSymbolsFromText）
   │  │  ├─ intent.ts                 全部意圖判斷正則與函式（是不是在問排行榜/技術指標篩選/
   │  │  │                            追問上文股票…）
   │  │  ├─ grounding/stock.ts        單一個股資料組裝（buildStockGrounding）
   │  │  ├─ grounding/movers.ts       排行榜/焦點資料組裝（buildMoversGrounding）
   │  │  ├─ grounding/techScreen.ts   多重技術指標篩選資料組裝
   │  │  ├─ grounding/holdings.ts     關注清單/持股資料組裝（含深度分析版本）
   │  │  ├─ grounding/theme.ts        主題概念股資料組裝
   │  │  ├─ grounding/indicators.ts   技術指標狀態→中文字串（跨上面幾個 grounding 檔共用）
   │  │  └─ askFallback.ts            AI 掛掉時的退路組字＋內部標記過濾（sanitizeLeakedMarkers）
   │  ├─ brief.ts                    每日 AI 快報生成邏輯，以台北時間日期當快取 key，4 段式
   │  │                              （大盤與台美連動/台股焦點/美股焦點/近期重點回顧）
   │  ├─ newsfeed.ts                 重大新聞頁邏輯：getNewsFeed() 抓 fetchNewsFeedPool() 的
   │  │                              新聞後，讓 AI 從最新 60 則裡挑出真正「可能影響大盤」等級
   │  │                              的消息當 pinned（回傳清單編號，不重寫標題，避免 AI 改寫
   │  │                              走樣；沒有夠格的消息就回傳空陣列，不硬湊）；一般項目的
   │  │                              summarizeItems()/summarizeBatch() **2026-09-14 起改抓
   │  │                              articleExtract.ts 擷取的文章全文來摘要**（原本只給標題，
   │  │                              摘要等於換句話重複標題，見下方工作日誌），擷取失敗才退回
   │  │                              原本的標題摘要，NewsFeedItem.summaryKind 標記兩者區別
   │  ├─ gemini.ts                   Gemini API 呼叫封裝（含自動探測可用模型名稱、
   │  │                              finishReason===MAX_TOKENS 截斷偵測）
   │  └─ types.ts                    ChatTurn 等共用型別
   │
   ├─ auth.ts                        NextAuth 設定（Google Provider）
   ├─ fineIndustry.ts                 細分產業排序/查詢邏輯（fineIndustryOf/sortByFineIndustry），
   │                                 純資料（300+組分類）拆到 fineIndustryGroups.ts，這裡只留邏輯
   ├─ fineIndustryGroups.ts           **2026-09-22新增**：細分產業分類表的純資料（FINE_INDUSTRY_
   │                                 GROUPS），跟fineIndustry.ts的邏輯分開，改排序/比對邏輯時
   │                                 不用把這一大串資料也讀進上下文
   ├─ watchlist.ts                   自選股清單邏輯（localStorage），含可選的 costBasis/shares
   │                                 持股成本欄位跟 updateHolding()
   ├─ watchlistStore.ts              登入後自選股的伺服器端 Redis 儲存
   ├─ priceAlerts.ts                 到價提醒的 localStorage CRUD，架構跟 watchlist.ts 一致
   ├─ signals.ts                     客觀技術訊號計算（不是預測，只描述當下數據狀態），含
   │                                 均線/爆量/創新高低/連漲跌，以及 RSI/MACD 黃金死亡交叉
   ├─ marketStatus.ts                判斷台股/美股目前是否為交易時段
   ├─ format.ts                      數字/價格格式化（含台股紅漲綠跌慣例）
   ├─ theme.ts                       深色模式相關輔助（讀 CSS 變數、fallback 色票）
   ├─ chatEvents.ts                  跨元件溝通用的事件（例如 AskAboutButton 通知 ChatWidget 换聚焦股票）
   └─ site.ts                        網站名稱/網址常數（SEO metadata 用）

├─ proxy.ts                          Next.js 16 的 proxy（原 middleware）：全站密碼保護閘門，
│                                     沒有 site_unlocked cookie 一律導去 /unlock，含 API 路由
└─ app/
   ├─ unlock/page.tsx + UnlockForm.tsx  密碼輸入頁
   └─ api/unlock/route.ts               驗證密碼、設定 cookie（預設密碼寫死在這個檔案）

根目錄:
├─ README.md          完整功能說明、環境變數設定、資料來源與限制、專案結構、設計慣例
├─ CLAUDE.md           使用者要求的品保流程規則（每次對話都要照做，見下方摘要）
├─ AGENTS.md            Next.js 版本提醒（這個版本跟訓練資料的 Next.js 可能有差異，寫程式前看 node_modules/next/dist/docs/）
├─ vercel.json          Vercel Cron 排程設定（每天觸發每日快報預生成，注意：這個一天一次的頻率
│                       不夠用來預熱 search/highlights，那個改用下面的 GitHub Actions）
├─ .github/workflows/warm-cache.yml  每 5 分鐘呼叫 /api/cron/warm-cache 預熱快取（見工作日誌）
└─ .env.example         需要的環境變數範例（AI API key、Redis、Google OAuth、SITE_PASSWORD，全部選用；
                        Redis 這幾個雖然程式碼邏輯上是選用，但正式站現在已經設定好了，見下方
                        「重要慣例與限制」）
```

## 目前所有功能（快速索引，細節見 README.md）

首頁大盤指數/AI快報/關注清單、個股頁報價+K線+技術訊號（均線位置/均線多空排列/RSI/
MACD含0軸強弱判讀/KD/布林通道）+
基本面（含P/B）+籌碼面（三大法人買賣超/融資融券，僅台股）+重大訊息公告（僅台股）+
AI問答+到價提醒、搜尋/篩選頁（產業多選+價格區間自訂+漲跌幅自訂區間+成交量區間+
「價量關係」偏多/偏空/中性多選篩選，**2026-09-14 新增後三項**，價量關係是技術分析
的價漲/跌量增推論、非真實買賣單資料，見下方工作日誌與已知問題）、每日焦點榜單（漲跌幅/成交量/技術
訊號共振）、**重大新聞頁**（AI 置頂可能影響大盤的重大消息+白話摘要+無限捲動瀏覽近期
所有新聞與真實籌碼/技術資料卡，卡片分成摘要跟連結兩塊，不會整張卡片直接跳走）、
**今日建議頁**（給沒有股市背景的人看的白話「今天該怎麼做」，專有名詞都會順帶解釋）、
AI 多輪問答（任何個股問答都會附上自己的技術訊號、不只技術訊號共振股才有；可分析整個
關注清單、依持股成本算損益、綜合基本面/財報/籌碼面/消息面/技術面給出明確看法，且不
只套用升息單一角度分析漲跌關聯；會整合重大新聞頁已篩選的置頂事件；可引用真實新聞與
財報——台股月營收年增率/季報EPS、美股季度EPS，新聞來源 Google 新聞 RSS 中英雙語；
回答刻意設計成新手也看得懂，術語會順帶白話解釋）、每日 AI 快報（4 段式：大盤與台美
連動/台股焦點/美股焦點/近期重點回顧，Vercel Cron 排程）、關注清單＋持股成本追蹤
（localStorage，登入後跨裝置同步）、到價提醒（目前僅網頁內顯示）、深色模式、共用 Redis 快取
（**2026-09-11 起正式站已設定，Upstash 免費方案**）、背景自動預熱（GitHub Actions 每 5 分鐘）、
**台股三個板全涵蓋：上市（TWSE）+上櫃（TPEx）+興櫃（Emerging，2026-09-20 新增，363 檔，
報價/K線/月營收/季報EPS，個股頁與 AI 問答會主動說明興櫃的議價交易制度與風險；興櫃刻意
不進排行榜/篩選頁）**、
Google 登入（選用）、全站密碼保護（`SITE_PASSWORD`）、全站 SEO metadata。**全站不使用
任何示範/假資料**——抓不到就誠實顯示「資料暫缺」。**網站現在是密碼保護的私人工具，不是對外公開
服務**，AI 問答會直接給明確推薦/看法，這點跟一般公開股票網站的「不做投資建議」慣例不同，見
「重要慣例與限制」。

## 重要慣例與限制

- **紅漲綠跌**：台灣/中國市場慣例，跟美股常見的反過來，全站配色與 `format.ts` 都照這個做。
- **AI 問答的建議尺度跟網站是否公開綁在一起，不是單純的文案風格選擇**：網站現在有密碼保護
  （見下方工作日誌 2026-09-11、`src/proxy.ts`），只有使用者跟家人用，所以 `lib/ai/ask.ts`
  的系統提示詞允許直接給明確個人看法/推薦。**這個前提很重要**：台灣證券投顧法規管的是「對不
  特定多數人」提供投資推介，判斷基準是網站有沒有做存取限制，不是使用者自己覺得是不是私人
  用途。如果之後把密碼保護拿掉、或網站又變成任何人都能進來，AI 問答務必要改回客觀數據描述、
  不做買賣建議/漲跌預測的版本（`getMultiSignalStocks` 在 `lib/data/momentum.ts` 的註解本來就是
  照這個原則設計的——2026-09-21 `lib/data/index.ts` 拆分後，這個函式本體搬到 momentum.ts，
  index.ts 現在只是re-export的barrel，不要再去那邊找函式本體或註解）——**不要因為看到這裡的
  舊版指示殘留就假設現在還是客觀中立的版本，先看 `lib/ai/ask.ts` 目前實際的系統提示詞內容
  再判斷。**
- **雙市場一律用分頁，不並排**：`MarketTabs` 元件，全站慣例。
- **這台本機開發環境（Windows PC）對外網路正常、能連到正式站**：跟這份文件更早版本記錄的
  「sandbox 連不到外部」不同（那是另一台/另一個環境的限制，不是這台）。這台機器上已經裝好
  Node.js（`winget install OpenJS.NodeJS.LTS`）跟 Playwright（裝在系統暫存資料夾，不在專案
  `node_modules` 裡），可以真的開瀏覽器測試正式站，也能 `npm install && npm run build &&
  npm run start` 在本機起服務打真實上游資料驗證修改。如果換了一台新環境，還是要重新確認一次
  網路/工具限制，不要照抄這段。

## 常見雷區索引（遇到類似症狀，先搜尋這裡，再決定要不要重新除錯）

這份清單只放「症狀關鍵字 → 一句話結論 → 去 `PROGRESS-ARCHIVE.md` 查哪裡」，不放推理過程本身
（過程都在 archive 裡），目的是讓主檔維持精簡的同時，還是能在遇到似曾相識的問題時，一眼看出
「這個已經解過」，不用重新推理除錯一次。**每次在 archive 裡新增一筆「花了不少力氣才查出根因」
的紀錄時，都要在這裡補一條索引**，格式固定：日期＋可以直接用 Ctrl+F／grep 精確找到那個章節
標題的原文片段。

- **上櫃(TPEx)股票報價卡在昨天收盤**：官方 OpenAPI（`tpex_mainboard_quotes`）其實是盤後資料，
  改用即時端點（`mis.twse.com.tw` 的 `otc_` 前綴）解決。→ archive：2026-09-15（晚間），搜尋
  「全台股上櫃(TPEx)股票報價系統性地卡在」。
- **TPEx 相關功能本機全過、正式站卻連續失敗**：三個各自獨立的根因——TLS中繼憑證缺失、大檔案
  端點回應不穩定、universe 快取沒有區分成功/降級結果的 TTL。→ archive：2026-09-14，搜尋
  「TPEx 正式站三個獨立根因排查」。
- **漲跌停鎖住的股票被顯示成 0% 漲跌幅**：即時報價的 `z`（最新成交）欄位和 bid/ask 深度可能
  同時失效，要加一層 `trade.z`（實際最後成交價）備援。→ archive：2026-09-15（晚間，續），搜尋
  「漲跌停鎖住的股票會被誤判成 0% 漲跌幅」。
- **內外盤（買氣/賣壓）定義或顏色顯示反了**：外盤＝買方主動追價（買氣，顯示紅）；內盤＝賣方
  主動降價求售（賣壓，顯示綠）——不是直覺以為的相反。→ archive：2026-09-15（凌晨，續），搜尋
  「修好內外盤定義寫反的問題」。
- **關注名單的損益平衡價／損益，跟使用者真實券商App（玉山證券）算出來的數字對不起來**：手續費
  要逐筆無條件捨去到整數元（不是連續小數直接乘），損益平衡價則是用投資金額除以賣出係數後再
  無條件進位到分。這組公式已經拿使用者真實7檔持股逐元核對過完全吻合。→ archive：2026-09-15
  （晚間，第七續／第八續／第九續），搜尋「玉山7檔全部完全一致」或「玉山證券App比對投資」。
- **用 curl 測試中文（CJK）內容的 API，回應結果離奇到像是踩到假bug**：bash 的字串插值／
  `for ch in ...` 迴圈處理中文字元容易編碼錯誤，導致送出去的內容其實不是原本打的字。要改用
  Node 寫一個 UTF-8 檔案再 `curl --data-binary @file` 送出。→ archive：2026-09-15（晚間，
  第六續），搜尋「記錄一個測試方法論教訓」。
- **台股搜尋／排行榜查不到某些明明有上市的股票**：`universe.ts` 的 `MAX_TWSE_UNIVERSE` 上限
  設太小（曾經是500，實際上市有1000多檔），漏掉約600檔。已調高到1200。→ archive：2026-09-15
  （深夜），搜尋「台股上市收錄補齊約600檔」。
- **`mis.twse.com.tw` 對這台上游的請求太密集會被靜默斷線/短暫封鎖IP（不會回429）**：全市場
  批次報價（TWSE+TPEx共用同一台主機）原本無上限併發約40個連線，實測150併發會有39%失敗；
  夾在同一波併發裡的其他單檔查詢（例如大盤指數）常是被丟掉的那個，且失敗若被當正常結果整個
  TTL快取，會讓「上游其實已恢復」卻要等滿TTL才重試。任何要對這個主機發起批次/高併發請求的
  新功能都要留意這個上限，別無上限扇出。→ archive：2026-09-21（九續），搜尋
  「根治`/api/indices`間歇性漏抓TAIEX」。
- **這台機器（Windows Git Bash）用 `TZ=Asia/Taipei date` 查時間會靜默算錯**：環境沒有IANA
  時區資料庫，`TZ` 變數被忽略，印出來的其實是系統本地/UTC時間卻誤標成台北時間——這次因此
  誤判「現在是凌晨、市場還沒開盤」，實際台北時間已經下午、TW股市已收盤，被使用者當場點破
  「市場剛收盤，哪來的開盤」。**之後查任何時區時間一律改用**
  `node -e "console.log(new Date().toLocaleString('en-US', {timeZone: 'Asia/Taipei'}))"`
  （已驗證這個方式在這台機器上正確），不要再用 `TZ=... date`。→ archive：2026-09-21
  （十一續），搜尋「發現並記錄「`TZ=Asia/Taipei date` 在這台機器會靜默算錯」」。
- **台指期夜盤白天顯示「資料暫缺」，不是抓取失敗、是上游本來就把欄位清空**：
  `mis.taifex.com.tw` 在非夜盤時段（約05:00~15:00）會把價格欄位清空回傳空字串，
  `fetchTaifexNightFutures()`依規則正確回傳null——一開始誤以為是快取/重試邏輯的問題
  （套用跟`/api/indices`一樣的`cachedWithDegradedNullTtl`修法對不到根因），繞了兩輪才
  查到真正原因。最終修法是另存一份24小時長效快照，白天讀不到即時資料時退回最後一次
  真正成功的收盤快照並強制標記`status:"closed"`。→ archive：2026-09-21（十四續）與
  更早的「新增台指期夜盤」章節，搜尋「台指期夜盤查出更深的根因」。

- **集保官網個股查詢（qryStock）curl送出總是回「查無此資料」**：要同一個cookie jar先GET拿
  JSESSIONID＋`SYNCHRONIZER_TOKEN`（綁session、每次查詢重拿），`firDate`填頁面隱藏欄位的最新週、
  `scaDate`填目標週，POST用已URL編碼的form字串；Node實作見`majorHolders.ts`的`queryTdccWebOnce`
  （偶發失敗重試一次）。→ 工作日誌 2026-09-30，搜尋「個股頁新增「籌碼比例」摘要」。
- **多個agent同時在同一個工作目錄commit，自己的檔案被別人的commit帶走**：git index是共用的，
  A先`git add`、B接著`git commit`就會把A暫存的檔案一起提交（2026-10-01 Finnhub那批就被K線修復的
  `c84a156`帶走）。平行作業時暫存完要立刻commit，或各自用`git worktree`。→ 工作日誌 2026-10-01，
  搜尋「FRED總體經濟＋Finnhub美股備援」。
- **冷門股K線圖噴 pageerror「Value is null」、整張圖畫不出來**：TWSE STOCK_DAY 在「只有零星/鉅額
  成交」的日子開高低收回 `"--"`→NaN→JSON null。所有K線資料源產出時一律過 `candleSanity.ts` 的
  `sanitizeCandles()`（整根略過、不編價格），新資料源也要套。另：對 TWSE 短時間併發/連打會回 HTTP 428
  限流，表現成圖表 503，測試時別狂打。→ 工作日誌 2026-10-01，搜尋「修好冷門股K線圖「Value is null」」。
- **Groq 回 413「Request too large…TPM」、NVIDIA 大模型等到逾時沒回**：Groq 免費層每模型每分鐘8,000
  token且「提示詞＋max_tokens」單次超過就拒（AI問答系統提示詞本身就約8,600 token），qwen另有每分鐘
  1,000輸出token上限；NVIDIA 免費層 kimi-k3/deepseek/glm/gemma 排隊90秒以上，只有 nemotron-3-super
  可用，且思考模式做 JSON 摘要會失控（98秒+截斷）→ 要用 `simpleTask` 關思考。換模型前先重測。
  → 工作日誌 2026-10-01，搜尋「AI供應商層接入NVIDIA與Groq」。
- **Adanos 額度「每月250次」不是日曆月**：依註冊日起算的帳單週期（2026-10-01實測回 `x-ratelimit-reset-monthly: 2026-10-22T14:15:52Z`），
  所以護欄以回應標頭的 remaining/reset 為主、自己的月計數只是保底；trending 預設只算「UTC今天」，一定要帶 `from` 才有7日樣本。
  → 工作日誌 2026-10-01，搜尋「美股「社群情緒」接入 Adanos」。
- **K線某區間（常見5y/10y）全站連續幾分鐘都回503「目前無法取得歷史圖表資料」**：TWSE限流讓任一月份失敗→整張圖null，
  舊版把null當正常結果快取5分鐘；已改失敗只快取30秒。測試時連打多檔長區間本身就會觸發限流。→ 工作日誌 2026-10-01，搜尋「修K線失敗快取」。
- **關注清單拖曳畫面有動、重新整理卻打回原狀（往下拖才會）**：React重排列搬動被拖DOM→`lostpointercapture`→把手的`onPointerUp`不觸發；拖曳的move/up要掛window。→ 工作日誌 2026-10-01，搜尋「關注清單往下拖曳順序沒存」。
- **某檔（常見興櫃/上櫃）偶發「資料暫缺」、直接打上游卻正常**：任何「失敗回null」的`cached()`都會把null快取滿TTL並經Redis傳給所有人，前端重試無效；改用`cachedWithDegradedNullTtl`。→ 工作日誌 2026-10-01，搜尋「單檔報價失敗null快取60秒」。

## 品保流程（詳細規則見 CLAUDE.md，這裡只摘要）

使用者要求每次對話回報「更新完成」前要走完：
1. **規則一**：同一類問題卡關連續失敗 2 次，第 3 次要同步派 2 個不同模型 agent 上網查解法，交疊進行不間斷。
2. **規則二**：自己先做一次完整的實測（build+start+curl，模擬瀏覽器操作）地毯式檢查，抓到的問題全部修好；之後只要針對這次修的問題複查即可，不必每次重新全站掃。
3. **規則三**：規則二做完後，派 1 個 Opus agent（額度不夠才臨時換模型頂替，之後仍改回 Opus）做一次完整地毯式檢查；抓到的問題自己修，修不好就讓 Opus 直接動手；之後只需針對這次修的問題再複查，直到 Opus 確認「沒有發現問題」才能回報「更新完成」。
4. **規則四**：每次回覆使用者都要附上網站網址 https://stock-web-blond.vercel.app 。**網址跟密碼絕對不能寫在同一行/緊接在一起**（會被通訊軟體自動連結辨識吞掉變成壞連結，這件事已經真實發生過不只一次），務必分開兩行。
5. **規則五（跨裝置接續）**：每次回覆使用者之前，都要更新這份 PROGRESS.md 並 push，讓其他裝置的 Claude Code 接得上。
6. **規則六**：只要在等待背景工作完成（部署、下載、agent 執行等）導致一段時間沒有新回應，每最多 5 分鐘要在對話視窗主動回報一次目前狀態，不能整段沉默、也不能只依賴「完成才通知」的機制悶著頭等。

## 工作日誌（新到舊，只列有意義的變更；commit hash 對應 `git log`）

### 2026-10-01：/search 搜尋篩選頁排序下拉新增大戶／外資／融資三項（`49c785b`）（Opus正式站複查通過）

`searchStocks()` 的 `sortBy` 增加 `major`/`foreign`/`margin`，後端用 `getChipsRatiosBatch()`（全市場整包快取、純記憶體查表）對篩選後的台股排序，缺資料一律墊底、兩個方向都不變；前端只在台股分頁顯示這三項。Opus 在正式站驗證：台股 1979 筆三項雙向單調、半導體業 207 筆缺資料墊底、關鍵字與切回漲跌幅正常、390px 不破版、console 0 錯誤。

### 2026-10-01：Opus複查順帶修兩個既有bug——關注清單往下拖曳順序沒存、單檔報價失敗null快取60秒（`fd73497`＋`c3a33a5`）

拖曳：往下拖時React搬動被拖那列的DOM觸發`lostpointercapture`，`pointerup`落在一般儲存格、`handlePointerUp`沒被呼叫→順序沒寫進localStorage；改成拖曳期間在window監聽move/up/cancel。報價：`getQuote()`用一般`cached()`，上游偶發失敗的null被寫進記憶體＋Redis存活整個TTL（盤中60秒），關注清單前端1.2秒後的重試必打到同一份null→該檔顯示「資料暫缺」（6610／7893／8069輪流中招，非6610本身問題）；改用`cachedWithDegradedNullTtl`降級TTL 1秒（不在官方清單的代號維持完整TTL防爬蟲放大）。驗證：tsc/eslint/build過；正式站Playwright桌機上下拖、手機觸控上下拖皆重新整理保留，完整回歸0失敗、無503。

### 2026-10-01：關注清單新增依大戶／外資／融資排序＋籌碼三欄改為「大戶／外資／融資」由左到右（`bf741ce`）（Opus正式站複查通過）

使用者要求。`ChipsRatioCells`（全站列表）與個股頁`ChipsRatioSummary`同步改順序；`useChipsRatios.ts`新增`ensureChipsRatios()`（繞過畫面觀察、一次批次取齊整組台股代號，全部有結果才resolve）與`getChipsRatioValue()`。持有中排序選單加三項（沿用方向鈕），僅關注加三顆按鈕（再按切換方向，同「依產業排序」寫進手動順序）；取齊後才排、期間顯示「籌碼資料載入中…」，依本期比例排序，缺資料（美股／興櫃缺項／暫缺）不論方向都排最後。驗證：tsc/eslint/build過；正式站Playwright 16檔台股關注清單三項×兩方向排序正確、與API逐值一致、重新整理順序保留，/、/search、/highlights、個股頁順序一致，390/1440無溢出（僅`/api/quote/6610`興櫃報價503，屬既有資料暫缺）。

### 2026-10-01：K線長區間（5y/10y）單月重試＋已收盤月份記憶體快取（`799b195`）

正式站2330/1470 5y曾連續回503，但本機直連TWSE 61個月全成功→推測Vercel出口IP被個別月份請求限流。`twse.ts`新增`fetchMonthResilient`（單月失敗重試最多3次帶退避、長區間並行降到6、已收盤月份成功後存實例記憶體30分鐘），`getChart`失敗原因記錄並附在`/api/chart`的503 `detail`。部署後正式站2330/1470 5y三輪皆200（冷啟動約3.5秒，之後約0.7秒），這項結案；tpex.ts的長區間尚未套用同樣的重試。

### 2026-10-01：金鑰啟用後Opus正式站複查（FRED／AI供應商層／Finnhub／列表三欄／社群情緒）＋修K線失敗快取（`54f692f`）

台股盤中Playwright複查：總經卡片1440/390無溢出、9項與FRED官方API逐值吻合；AI問答6題全200（1.9~8.7秒）、繁中、有白話；Finnhub新聞有進AI grounding（個股頁本身無新聞區，設計如此）；列表三欄在關注清單／焦點排行／三榜單／搜尋三種排序共89列與`/api/chips-ratios`逐字一致，短表大戶有升降、長表「累積中」、美股表無三欄、390px可橫捲、console零錯誤；AAPL社群情緒卡美股盤前誠實顯示「資料暫缺」，2330無此卡。
發現：TWSE限流時K線（2330/1470 5y）抓失敗的null被`cached()`寫進Redis存活5分鐘→全站同一區間連續503；`getChart`改用`cachedWithDegradedNullTtl`（失敗30秒）；已部署，舊5分鐘快取過期後複測：2330 5y 10:15:04仍503、約45秒後恢復200，1470 5y兩輪皆200（失敗只卡30秒，確認生效）。1470「當日」因當天0成交Yahoo無分時資料回503屬正常無資料。AI偶有單次措辭瑕疵（漏寫總經資料日期、「優行」錯字），重問即正常，未改提示詞。

### 2026-10-01：美股「社群情緒」接入 Adanos（`16446eb`）

使用者決定美股盤中每天約10次、每月約220次可接受，作為推薦的「情緒」面向。只打 `/{reddit|x|news}/stocks/v1/trending?limit=100&from=7天前`（標頭 `X-API-Key`；一次回近7日最熱最多100檔，含 buzz_score／trend／mentions／bullish_pct／bearish_pct），三來源輪流、Redis `SET NX EX 2400` 跨實例鎖＝盤中約40分鐘1次，只在 `VERCEL_ENV=production`（或本機 `ADANOS_ALLOW_LOCAL=1`）＋美股盤中呼叫，其餘讀14天快照（`sentiment.ts`）；護欄 `adanosQuota.ts`：伺服器回報剩餘≤10停到重置、自計日12／月240（INCR）、無Redis或Redis錯誤一律不呼叫。美股個股頁新增「社群情緒」小卡＋AI grounding＋`RULE_SOCIAL_SENTIMENT`；不在榜上照實顯示「討論很少」、提及<20次不下偏多空結論。
驗證：tsc/eslint/build過；模擬fetch＋假Redis測鎖、非盤中、預覽、缺金鑰、日12/月240、剩餘≤10、429全擋得住（0次真實呼叫）；真實回應解析正確；390/1440px無溢出；缺金鑰AAPL頁小卡不出現、2330不出現。實測共用4次真實呼叫（10/1當時伺服器 used=6／250）。

### 2026-10-01：AI供應商層接入NVIDIA與Groq（`da17187`＋`d8c5032`）

目的：Gemini免費層常撞429時有免費備援。`callAiProviders`改為 Gemini→NVIDIA(nemotron-3-super)→Groq(gpt-oss-120b，只接得住小請求)→Claude，
429/5xx/逾時熔斷暫跳過、整條鏈總時限45秒、輸出端繁中把關；缺新金鑰時行為同原本。Groq新聞挑選品質不及Gemini（重複挑同事件、中國用語）故排最後；
NVIDIA忠於grounding數字但名詞白話解釋較少、深度分析25~37秒。Tavily評估後不做（理由見目前已知問題）。
驗證：tsc/eslint/build過；本機以假Gemini金鑰實測落到NVIDIA/Groq、無金鑰走原失敗路徑；5種問法對照正式站Gemini。

### 2026-10-01：所有股票列表新增籌碼比例三欄（融資使用率／外資持股／大戶持股(週)＋▲▼升降，`8462f6b`）

使用者要求不用點進個股頁，在搜尋篩選、首頁焦點排行、`/highlights`、關注清單（持有/僅關注）每列直接看到三項比例。新增批次API `/api/chips-ratios?symbols=`（只收台股、≤100檔、精簡tuple格式、`private, max-age=300`）＋`getChipsRatiosBatch`，只從全市場整包快取查表，不對每檔打上游、不進warm-cache；個股頁單檔版改走同一個`assembleRatios`。
前端`useChipsRatioRow`（`lib/useChipsRatios.ts`）：列進到畫面±600px才登記、80ms內合併成一次請求、以代號為key存模組層store（換排序不會錯位）；搜尋頁1979列只會要捲到的那幾十檔。大戶上一週：長列表只用本站週快照（目前顯示「累積中」，下次集保CSV換週約10/3後自動有升降），≤10列短表與關注清單第二階段`majorPrev=web`小批（≤8檔、並行2）補查集保官網；另修週快照在Redis讀取暫時失敗時會被只有本週的內容覆蓋、以及快照不相鄰（>10天）時仍被當上一週的漏洞。
驗證：tsc/eslint/build過；對帳28檔批次＝單檔、本機新版單檔與正式站舊版逐字相同；正式站Playwright 1440/390：關注清單持有/僅關注（含上櫃/興櫃/美股）、highlights成交量榜、搜尋兩種排序切換數字與API一致、無溢出、console零錯誤（三輪中第一輪出現6則來源不明503，之後未重現）。盤前測試，首頁焦點排行與漲跌幅榜台股當時是空清單，未實測到資料列（同一個StockTable元件）。

### 2026-10-01：修好冷門股K線圖「Value is null」（`c84a156`）
根因：TWSE STOCK_DAY 對只有零星/鉅額成交的日子回開高低收 `"--"`，`parseFloat` 得 NaN、JSON 變 null，
lightweight-charts 繪製丟錯（1470 的1年區間 242 根有 46 根壞；光9月就有26檔上市股中招，長區間更多）。
新增共用 `src/lib/data/candleSanity.ts`，TWSE/TPEx/Yahoo 產出K線時整根略過不合法K棒，`StockChart.tsx`
餵圖前再濾一次（不動 `candlesRange`）。驗證：tsc/eslint/build 過；正式站 Playwright 對 1470/1538/5906
全10區間、2330/6488/AAPL 回歸、全開8個技術線疊圖，console 零 pageerror、圖表皆正常畫出。

### 2026-10-01：FRED總體經濟＋Finnhub美股備援（`00864a8`；Finnhub部分被併進`c84a156`）

首頁大盤指數下方新增「美國總體經濟」卡片（`MacroCard`，Suspense串流），AI大盤概況（聊天／快報／今日建議）同步帶入9項FRED序列＋`RULE_MACRO_DATA`：DFF、DGS10、DGS2、T10Y2Y、CPI年增率（CPIAUCSL自算，已對FRED官方pc1吻合3.35%）、UNRATE、DTWEXBGS（非DXY）、VIXCLS、DCOILWTICO；日資料快取3h、月資料12h、缺項20分，不進warm-cache。
美股財報/基本面改「Yahoo為主、Finnhub備援」（實測兩邊EPS口徑不同，AAPL 2.02 vs 1.91，不換主來源），美股個股新聞再補Finnhub 4則；順修負EPS驚喜被寫成「優於市場預期-0.89%」。
Adanos（免費每月僅250次）、SEC API（官方EDGAR免費即可）、Hugging Face（金鑰無Inference權限403、冷啟動慢）評估後不接。
驗證：tsc/eslint/build過；本機有金鑰9項全抓到、快取命中0ms、模擬Yahoo被擋時Finnhub補上；清空金鑰的production build首頁200且卡片不出現、AI概況文字與舊版逐字相同；390/1440px截圖無溢出。**正式站需在Vercel加`FRED_API_KEY`、`FINNHUB_API_KEY`才會生效**，尚待Opus正式站驗證。

### 2026-09-30：個股頁新增「籌碼比例」摘要（融資使用率／外資持股比例／大戶持股比例＋升降，Opus正式站複查通過）

使用者要求像看盤軟體一樣一眼看到融資、外資、大戶比例與每日升降，放在個股頁報價正下方（台股限定，美股不顯示）。
來源：融資＝TWSE rwd `MI_MARGN`（取代晚一天且無日期的openapi版，含次一營業日限額）／TPEx `MarginPurchaseQuota`；外資＝TWSE `MI_QFIIS`／TPEx `www/zh-tw/insti/qfii`（兩者都能帶date查前一交易日）；
大戶＝集保CSV第15級（週資料），上一週優先用本站週快照、沒有時查集保官網個股頁（`majorHolders.ts`）。AI grounding同步帶入三項比例與已算好的升降＋`RULE_CHIPS_RATIOS`。
對帳環球晶6488與截圖完全吻合（前日融資16,064張/13.44%、外資122,238張/25.56%、大戶71.09%/45人/34.0萬張；集保CSV官方比例71.08是截斷，本站自算四捨五入）；tsc/eslint/build通過、本機390/1440px截圖無溢出，待Opus正式站驗證。
Opus正式站Playwright複查：6488/2330/7893/AAPL/1470/8431畫面與`/api/chips-ratios`一致、無NaN/溢出；唯一問題是AI回答大戶題沒講「集保每週公布的週資料」與週別，已加強`RULE_CHIPS_RATIOS`（必講週資料＋週別、名詞解釋不可省略）。

### 2026-09-30：AI問答「建議買什麼」改成從全市場找，不再只從關注清單挑（`134fb6c`＋`9e302c1`，Opus正式站複查通過）

使用者反映開放式買進建議都只從關注清單回答。根因：「建議買甚麼／有什麼可以布局」沒被
`MOVERS_INTENT_PATTERN`接住 → 沒附任何全市場資料，加上前端每題預設帶關注清單、提示詞永遠有
「逐檔講重點」規則，模型只剩關注清單可用。修法：`intent.ts`新增`wantsMarketWideBuyIdea`（明講
「我的關注清單／我持有的」時不觸發）並納入`wantsMovers`；`ask.ts`命中時附上與`/action`同一份
全市場多面向候選（`getActionBrief()`，30分鐘快取、逾時8秒放棄），並加`RULE_MARKET_WIDE_RECOMMENDATION`。
`tsc`/`eslint`通過。
Opus正式站Playwright複查抓到一個回歸：「我的關注清單裡建議買哪檔」也被附上全市場焦點資料，回答先列出清單外的
台灣精材再自己改口——根因是`conversationWantsMovers`用了沒排除限定範圍的裸正規式，`9e302c1`改用
`wantsMarketWideBuyIdea()`。複測：三種開放式問法都推薦全市場標的（快取熱時與`/action`同一份中美晶/南茂），
限定題只談清單三檔，單一個股與「分析我的關注清單」按鈕行為不變，個股頁抽查數字吻合。注意：今日建議快取冷時
聊天只等8秒就放棄附名單，那一題只會用今日焦點數據推薦（設計如此，非bug）。

### 2026-09-27：「當日」切換race condition Opus正式站複查通過，正式結案

Opus agent用Playwright在正式站`/stock/2330`監聽console/pageerror，做多組快速連點（完全不等待、
40ms、150~800ms間隔，當日↔3個月/6個月/5日/1年/10年/1個月），再正常速度逐一切換10個區間並截圖。
全程0個console錯誤，`Invalid date string`不再出現；當日為折線圖、其餘9個區間K棒正常顯示。

### 2026-09-27：修好K線圖快速切換到/離開「當日」的console錯誤（`d3c2268`）

使用者指名要求修復已知問題清單裡記錄的這個race condition。根因：資料形狀判斷（daily
純日期字串 vs today完整ISO時間戳）用即時range，但candles刻意保留舊range資料到新fetch
完成，中間會用錯的range去解讀舊資料格式。修法：新增`candlesRange` state跟candles綁定
更新，格式判斷改用它。`tsc`/`eslint`/`build`皆通過，已派Opus agent複查。

### 2026-09-23：全站地毯式優化——3項結構優化＋4項延伸拆分＋8項bug修復，Opus複查全通過

延續前一輪「地毯式檢查」要求：先做3項小優化（universe warm-up集中成`ensureTwUniverseWarm()`、
`fineIndustry.ts`拆出`fineIndustryGroups.ts`資料檔、`ask.ts`系統提示詞拆成`askSystemPrompt.ts`
具名常數），接著做全專案結構健檢抓到的4項延伸重構：①`actionBrief.ts`（572行）依職責拆成
`actionScoring.ts`（純評分邏輯）／`actionGrounding.ts`（候選組裝＋文字組裝）／`actionBrief.ts`
（只剩prompt與orchestration），②`ChatWidget.tsx`／`StockChart.tsx`／`StockTable.tsx`等元件的
UI小修（設定選單點外部關閉、手機版表格可橫向捲動提示），③`useFetchOnce`共用hook取代3處重複
fetch樣板，④新增`CLAUDE.md`規則九，把這次學到的8條程式碼結構原則寫下來，之後不用等累積到
需要大掃除才處理。同時派agent做全站地毯式bug巡檢，修復8項問題（2高：美股現價落在高低區間外
的日期比對邏輯、關注清單非空時的hydration錯誤；2中：AI問答輸入框首次開啟被壓扁、375px手機版
產業欄被壓縮；3低：試搓→試撮錯字、技術線設定選單點外部不會關閉、興櫃股票時間戳顯示00:00:00；
1提示詞：AI在術語解釋括號前多插一句過渡語）。所有變更都跑過`tsc`/`eslint`/`build`，並派Opus
agent用真實headless Chromium操作正式站逐項複查全部8項bug修復，全數通過、未發現新問題。
`actionBrief.ts`拆分後另派Opus複查`/action`頁面實際運作正常（通過）。`ChatWidget.tsx`的語音
輸入狀態機（~260行 Web Speech API 管理＋自動重啟邏輯）也拆成獨立的`src/lib/useVoiceInput.ts`
hook；拆分途中發現一個新版eslint規則`react-hooks/set-state-in-effect`的已知落差——同一段
「面板關閉時同步收麥克風＋清狀態」的effect邏輯留在原元件檔案裡不會被這條規則抓到，搬進獨立
hook檔案後就會被抓到，追查後確認是規則對「跨檔案抽出的effect」判斷較嚴格、不是重構引入的
新行為問題，加了針對性的`eslint-disable-next-line`並附註原因後解決。「4項都做」的最後一項——
`StockChart.tsx`技術指標系統改成table-driven（新增`src/lib/chartIndicatorDefs.ts`，8種指標
統一用`{key,label,pane,createSeries,computeData}`描述，之後新增指標只要在這份清單加一筆，
不用再回頭改元件裡5個分散的地方：refs宣告、建立series、套用資料、色票常數、設定選單清單）
也完成。這是本次優化風險最高的一項，除了tsc/eslint/build，額外起本機dev server用playwright-core
實測：8個指標checkbox全部勾選後子圖高度(750px)、顏色、K線圖疊圖全部正確，並用`git stash`
比對確認過程中發現的「切到當日／切回日K的race condition會噴lightweight-charts格式錯誤」是
重構前就存在的既有bug、不是這次拆分引入的，記錄到下方已知問題、暫不在此次任務範圍內處理。
**正式站另派Opus複查通過**：8指標全開/全關、美股MACD+RSI、切換1年/10年皆正常，並額外對每個
指標分別單獨勾選、用canvas像素色彩統計逐一比對，證實5種顏色都正確對應各自指標、無錯接，
子圖順序（MACD→RSI→KD）也與宣告順序相符，全程console零error。至此「4項都做」（actionBrief
拆分／ChatWidget語音hook／useFetchOnce共用hook／StockChart table-driven指標）全部完成並
複查通過，本輪地毯式優化＋bug巡檢結案。

### 2026-09-22：興櫃盤中即時性正式驗證通過（延續2026-09-20收錄時的未驗證項目）

2026-09-20收錄興櫃當天是週日無法驗證盤中即時性，這次在真正交易時段（09:34~09:49，
共12輪、間隔75秒）對正式站`/api/quote/<代號>?market=TW`連續查詢6696仁新、7729仲恩生醫、
6618永虹先進三檔活躍興櫃股。三檔的`updatedAt`皆隨查詢時間同步推進、成交量單調遞增
（6696從5,138,749股漲到7,138,061股）、價格持續變動，證實是真即時資料非盤後快照。
未發現bug，程式碼無變動。

### 2026-09-22：台股候選池間歇縮水——補做盤中真實交易時段驗證，正式結案

派agent在真正的盤中交易時段（09:00~13:30）對正式站做延續驗證，因為先前13次連續驗證
全部落在盤後（16:21~17:15），負載/上游併發狀況跟盤中不同。09:28~09:48盤中每65秒
取樣一次共18次，筆數落在1833~1982之間，未出現任何30%以上驟降，跟盤後結果一致。
確認修法（`MIS_BATCH_CONCURRENCY`限流+`cachedMapWithDegradedShortTtl()`，`13a42dc`）
在盤中負載下也穩定有效，這項正式結案。

### 2026-09-22：AI問答兩個真實bug——幻覺公司名稱、誤導性的「沒有持股權限」

使用者實測抓到：①問「5274呢？」，AI回答「宏觀電通(5274)這檔本站其實有涵蓋...」——
5274其實是信驊，「宏觀電通」是模型自己編的、資料庫裡查無此名。根因：`ask.ts`的
`describeUnresolved()`（處理「代號查得到但這次抓不到即時資料」的情況）只把代號傳給
模型，沒有附真實公司名稱，模型只好自己用訓練知識猜、猜錯。修法：從`findInUniverse()`
查真實名稱一起附上（例如「信驊(5274)」），系統提示詞也加一條明講「照抄附的名稱，
不要自己換成別的」。②問「有沒有虧損的股票建議停損？」，AI回答「系統並沒有自動綁定
或直接讀取你個人帳戶持股的權限」——這是錯的，本站本來就有「我的關注清單/持股」
這個功能（分析我的關注清單按鈕），只是`ChatWidget.tsx`的`send()`只有那顆按鈕會帶
`getWatchlist()`，一般打字問的問題完全沒帶這份資料，AI才會誤以為整個做不到。修法：
`send()`的holdings參數改成預設值`getWatchlist()`，讓任何打字問題都自動帶上目前的
關注清單；同時系統提示詞加一條：真的沒有這個區塊時（代表清單是空的），要照實說
「你的關注清單還沒加股票」，不能講成「沒有讀取權限」。`tsc`/`eslint`/`build`皆通過。

### 2026-09-22：關注清單產業別真正接上真實資料（取代寫死的「自選」）

使用者反映關注清單很多股票產業欄位顯示「其他」。第一步（`0f5d14c`）把`fineIndustry.ts`
找不到細分族群時的退路，從空洞的「其他」改成退回股票的官方`sector`欄位——但驗證時（用
未收錄的億豐8464測試）發現畫面顯示的是「自選」而不是官方產業別，才找到真正根因：
`WatchlistSection.tsx`的`onFetch`一直對每一列的`sector`欄位寫死`"自選"`字串，因為它用的
單檔`/api/quote/[symbol]`端點本身根本沒有回傳`sector`。修法：在`/api/quote/[symbol]`
（伺服器端執行）額外用`findInUniverse()`查官方股票清單附加`sector`到回傳JSON，前端改讀
這個真實值。**注意**：不能直接在`WatchlistSection.tsx`（client component）裡`import
findInUniverse`來查——試過一次，`lib/data`模組圖會把`node:tls`等server-only依賴一起拉進
瀏覽器端bundle，導致`next build`直接失敗（Turbopack報`does not support external modules`），
必須讓查詢留在API路由裡完成，前端只讀回傳的欄位。`tsc`/`eslint`/`build`皆通過。

**第二輪修正（同一天）**：Opus瀏覽器複查當下用的測試股（8464/9945/2504）都正確顯示，
但推上線後使用者實測發現整份關注清單裡還是有一半股票顯示「自選」（信驊5274、恩德1528、
順德2351、光罩2338、全友2305、雍智科技6683、和益1709），另一半正常（聯電2303、宏碁資訊
6811、長榮2603、陽明2609）。根因：`findInUniverse()`讀的`twFullCompanySnapshot`是模組
層級的同步快照，在`getTwUniverse()`第一次真的在該無伺服器實例執行過之前，只是一份很小的
內建SEED清單——顯示正常的那幾檔剛好都在SEED裡，顯示「自選」的都不在。這是`symbolResolve.ts`
的`guessSymbolsFromText()`早就踩過、也修過的同一類坑（那邊的解法是先await一次
`getTwUniverse()`），但`/api/quote/[symbol]`這次新增的sector查詢沒有套用同樣的修法。
補上：TW市場先`await getTwUniverse()`（Redis快取，非冷啟動時幾乎免費）再查
`findInUniverse()`。`tsc`/`eslint`/`build`皆通過。**Opus瀏覽器複查（`58142c0`）用使用者
實際回報失敗的7檔重測**：恩德1528→電機機械、和益1709→化學工業、全友2305→電腦及週邊設備業、
光罩2338→半導體業、順德2351→半導體業、信驊5274→半導體業、雍智科技6683→半導體業，全部
正確顯示、無一顯示「自選」，`/api/quote`回應也都確認帶`sector`。正式結案。

### 2026-09-22：搜尋結果／焦點排行也套用細分產業，不再只顯示籠統的官方分類

使用者反映：修好「自選」問題後，搜尋(`/search`)跟焦點排行(`LiveMoversBoard`)的「產業」
欄還是顯示「電機機械」「半導體業」「貨櫃航運」這種太籠統的官方分類，要看的是像關注
清單那樣「實際做的內容相近」的細分族群（例如IC設計、載板、矽晶圓）。根因：這兩處都
用`StockTable.tsx`渲染，直接印`item.sector`（官方分類），完全沒有走`fineIndustry.ts`
的`fineIndustryOf()`（只有`WatchlistTable.tsx`有走）。修法：`StockTable.tsx`改用
`fineIndustryOf(item)`，`SearchItem`本身就有`symbol`/`market`/`sector`欄位、直接符合
`fineIndustryOf`要的形狀，不用改資料層。同時把原本寫死在`WatchlistTable.tsx`裡的
`FINE_INDUSTRY_HINT`說明文字搬到`fineIndustry.ts`匯出共用，兩處表頭提示文字保證一致、
不會之後改一邊忘了改另一邊。搜尋/篩選條件（`sector`下拉選單）維持用官方分類篩選，
只有顯示欄位改成細分產業，不影響篩選邏輯。`tsc`/`eslint`/`build`皆通過。**Opus瀏覽器
複查通過**：`/search`與首頁焦點排行（台股、美股皆然）指名股票（2330→晶圓代工／晶圓
製造、2454→IC設計、2603/2609→貨櫃航運）與預設排行榜列表都正確顯示細分分類；未收錄
的股票正常退回官方分類（9945→其他業、1215→食品工業等），非「其他」空白。正式結案。

### 2026-09-22：細分產業表大規模擴充——連沒收錄的股票也盡量給細分類

使用者不滿意「沒收錄到細分表的股票退回官方粗分類」這個既有的正常退路機制，明確要求
「連沒收錄的也要細分」。原本表只手動整理了239檔（關注清單常見主流股），要擴大到
全台股（上市約1094＋上櫃約891，共1982檔candidate pool，扣掉239檔剩1743檔待分類）
規模太大沒辦法一次處理完，跟使用者確認後選擇「大幅擴充到最大範圍」的做法。
執行方式：先用API抓全台股清單、比對出1743檔未收錄股票，依官方粗分類切成9批
（每批150~250檔），同時派9個agent各自憑自己對台股上市櫃公司的知識分類，明確要求
「不熟悉的公司寧可跳過、不要瞎猜」（比涵蓋率更重要，符合本站一貫的不編造原則）。
9批全部回報後合併：新增300組、涵蓋992檔（1743檔裡約57%找到了細分分類），寫程式
驗證過沒有跟既有239檔衝突、跨批次也沒有重複代號。過程中一度整批因為撞到工作階段
用量限制全部失敗（`resets 1:40pm`），等重置時間過了原封不動重跑一次就全部成功，
沒有遺失資料。`tsc`/`eslint`/`build`皆通過，最終驗證整份表（含既有239檔）共1231個
不重複代號、零重複。剩下約751檔（agent覺得沒把握、刻意跳過的）繼續退回官方粗分類，
這是設計上刻意保留的誠實退路，不是遺漏。**Opus瀏覽器複查通過**：使用者截圖裡的
5274信驊／2338光罩／1709和益／2305全友都正確顯示新的細分分類；1528恩德／2351順德／
6683雍智科技這3檔（agent判斷沒把握、刻意跳過）如預期正常退回官方粗分類，非「自選」
也非空白；額外查證聯茂/精材等既有細分分類與/search排行榜皆未受影響，無regression。
正式結案。

### 2026-09-22：關注清單持有/未持有各別顯示檔數＋所有股票清單加上序號

使用者要求：①關注清單「持有中」「僅關注（未持有）」兩組標題各自附上目前檔數；
②所有列出股票的地方（關注清單、搜尋、焦點排行）都加上1、2、3...序號，且改排序/
篩選後要從1重新排。做法：`WatchlistTable.tsx`把兩個`DraggableGroup`的`title`改成
`` `持有中（${held.length}）` ``/`` `僅關注（未持有）（${unheld.length}）` ``
（後者原本held.length===0時會整個不顯示標題，這次改成一律顯示，因為使用者現在
一定要看到檔數）；兩個表格（`WatchlistTable.tsx`的`DraggableGroup`、`StockTable.tsx`）
的`<tbody>`map都新增一個`#`欄位，直接用陣列目前的index（`order.map((key, index) =>`／
`items.map((item, index) =>`）當序號——這樣改排序/拖曳/篩選時，父層重新算出新陣列，
序號自然跟著從1重新編號，不需要額外邏輯維護一份獨立的排名狀態。`StockTable.tsx`
同時服務`/search`、首頁焦點排行、`/highlights`三個地方，改一處全部套用。`tsc`/
`eslint`/`build`皆通過。**Opus瀏覽器複查通過**：分組檔數正確（持有中2／僅關注3）；
兩組各自的#欄獨立從1編號（不會接續變4、5、6）；持有中/僅關注改排序、/search改排序
欄位/方向/套用篩選、焦點排行台美股頁籤，序號都正確從1重新連號；版面對齊無錯位。
正式結案。

### 2026-09-22：三項結構性重構——回應使用者對「改東西要快、不要大範圍搜索」的要求

使用者問「現在的分層能不能讓你快速對症下藥、少花token」，據實回報今天實際碰到的兩個
真實摩擦點後，使用者要求優化這兩項、外加一次全站地毯式檢查（見下方另一則工作日誌）。
三項重構如下，皆為**純結構重組，內容/行為零改動**（每項都有另外寫程式驗證前後輸出
逐字元相同，不是只憑肉眼檢查）：
1. **`findInUniverse()`的隱藏前置條件**：改在唯一的單檔報價入口`getQuote()`
   （`lib/data/quote.ts`）內部統一warm一次TW universe快取，取代要求每個下游呼叫端
   各自記得warm（這正是當天`/api/quote/[symbol]`那個bug的根因類型）。`/api/quote/
   [symbol]/route.ts`原本的手動warm呼叫因此可以移除，改由`getQuote()`保證。
2. **`fineIndustry.ts`資料/邏輯分離**：300+組分類資料搬到新檔`fineIndustryGroups.ts`，
   `fineIndustry.ts`只留`fineIndustryOf()`/`sortByFineIndustry()`等邏輯函式（529行→
   92行），之後改排序邏輯不用把一大串資料也讀進上下文。
3. **`ask.ts`系統提示詞拆成具名常數**：新檔`askSystemPrompt.ts`，原本33個擠在一個陣列
   字面值裡的規則（含2個依對話情境切換分支的三元判斷）各自變成`RULE_XXX`具名常數，
   `ask.ts`本身從包含這一大段提示詞降到約120行。**驗證方式**：寫程式把改動前
   的33個陣列元素原始碼、跟改動後33個具名常數的原始碼，分別在
   `wantsHoldingsAnalysis`/`wantsSingleStockAnalysis`兩個布林值的全部4種組合下求值
   比對，4種組合輸出字串逐字元完全相同（8918~10179字不等）。`tsc`/`eslint`/`build`
   三項重構皆通過。

### 2026-09-22：地毯式審計第一批修復——資料層3項

派2個Explore agent地毯式審查`lib/data/`+`api/`跟`lib/ai/`+`components/`找「容易散落
多處忘記同步改」的結構性風險，資料層那份回報3項，全部修好：
1. `NO_TRADE_MID_ESTIMATE_NOTE`原本在`twse.ts`/`tpex.ts`各自宣告一份一模一樣的字串
   （`tpex.ts`裡甚至留了「必須跟twse.ts保持一致」的提醒註解——這正是「已知風險但
   沒真正解決」的例子），搬到`types.ts`共用匯出，兩邊改用同一份。
2. `findInUniverse`/`searchUniverseByQuery`/`sectorsFor`這幾個同步函式的「呼叫前必須
   先warm」前提，原本`/api/sectors`、`/api/symbol-lookup`各自手寫`await getTwUniverse()
   .catch(...)`並各自留長註解提醒自己（`/api/symbol-lookup`那段還點名這是2026-09-14
   「美利達查不到」的舊坑，代表這個地雷已經咬過兩次不同呼叫端）。新增具名函式
   `ensureTwUniverseWarm()`（`universe.ts`），這3個同步函式的JSDoc也都加上明確警告，
   四個呼叫端（`quote.ts`、`symbolResolve.ts`、`/api/sectors`、`/api/symbol-lookup`）
   統一改用這個具名函式，之後`grep -rn ensureTwUniverseWarm`就能一眼看出哪些進入點
   已經處理過。
3. `/api/cron/warm-cache`裡有4項（`searchStocks`TW/US、`getMultiSignalStocks`TW/US、
   `getIndices()`）沒有包這支路由自己宣稱的`warm()`錯誤隔離機制，任一項拋錯會讓整個
   `Promise.all`直接中止、回應退化成籠統的503——補上跟其他項目一致的包法。
`tsc`/`eslint`/`build`皆通過。

**AI層/元件那份的發現，已修復的部分**：
1. 「【大盤概況（台股＋美股）】」內文組裝邏輯原本在`ask.ts`/`actionBrief.ts`/`brief.ts`
   三處各自重複一份幾乎相同的程式碼，抽成共用函式`buildMarketOverviewText()`
   （新檔`lib/ai/marketOverview.ts`），三處改成呼叫它。
2. `SiteHeader.tsx`桌機版／手機版導覽列原本各自硬寫一次完全相同的5個項目，改成
   共用陣列`NAV_ITEMS`搭配`.map()`渲染，兩處只差className。

**看過但判斷不值得處理／風險大於效益，故意不動的部分**：
- `indicators.ts`的`describeTechState`/`describeIndicatorState`/`describeHoldingTechnical`
  三個函式各自重複組裝MACD/KD交叉描述——三處輸出格式跟詳細程度是真的不一樣（帶不帶
  KD區間位置、帶不帶K/D精確值），硬合併容易在參數化過程中不小心改動某處原本的措辭，
  對AI回答品質的風險大於重複程式碼本身的維護成本；改成在三個函式加上「必須同步更新」
  的提醒註解，比照本站對`signals.ts`/`indicators.ts`的`ema()`已經採用的處理方式。
- `SearchClient.tsx`的`SectorMultiSelect`/`VolumeTrendMultiSelect`結構相似，但左右
  對齊方式不同是先前真的修過的排版bug（`left-0`避免192px選單超出視窗），只有2個
  呼叫端，強行合併成通用元件風險大於效益，維持現狀。
- `actionBrief.ts`（570行，職責混雜）、`ChatWidget.tsx`（518行，語音輸入邏輯可抽成
  獨立hook）、`StockChart.tsx`（新增一個技術指標要同步改5處，可考慮表格驅動）、
  6個元件各自手刻「一次性fetch」樣板（可抽共用hook）——這幾項是較大範圍的重構，
  效益存在但需要更完整的回歸測試才能安心動手，這次先不做，留在這裡供之後評估。
- 巡查時額外發現`SiteHeader.tsx`有一個既存（跟這次改動無關）的
  `react-hooks/set-state-in-effect` lint錯誤（搜尋建議框的debounce effect），
  `npm run build`本身不受影響（linter設定沒有把它當成build失敗條件），但獨立跑
  `eslint`會報錯——記錄在這裡，之後有空可以處理，不算這次地毯式檢查的必修項目。

`tsc`/`build`皆通過（上述SiteHeader.tsx既有lint錯誤跟這次改動的3個檔案無關）。

**Opus瀏覽器複查（`e8dd247`＋`f6d35ed`兩批合併驗證）全數通過**：導覽列桌機/手機版5個
項目與連結皆正確；8464/5274的關注清單產業別正確顯示細分分類（不是自選）；搜尋「美利達」
建議清單正常；首頁/`/action`的大盤概況與台指期夜盤資訊完整無缺漏；AI問答引用大盤數字
正確、夜盤狀態標示格式正確。未發現任何回歸，正式結案。

### 2026-09-22：地毯式審計第二批修復——共用fetch hook（優化清單4項之1）

使用者要求把先前評估「效益存在但風險需要更完整測試」的4項優化全部做完，依風險排序
從最安全的開始。新增`lib/useFetchOnce.ts`（`{data, failed}`共用hook），取代
`ActionBriefCard.tsx`/`DailyBriefCard.tsx`/`MomentumSection.tsx`三處各自手刻的
「掛載時抓一次、處理loading/失敗、卸載後不更新state」樣板。**刻意排除**
`NewsFeedList.tsx`（有分頁載入更多）、`SearchClient.tsx`（篩選變動要用
AbortController取消重抓）、`StockChart.tsx`（symbol/range/market變動要重新抓）
這三個——它們的抓取語意本質上更複雜，硬塞進同一個hook會犧牲清晰度，維持各自實作。
`tsc`/`eslint`/`build`皆通過。同時把這次歸納出的判斷準則寫進CLAUDE.md規則九，
之後改程式碼要主動套用這些原則，不用等到大掃除。

### 2026-09-23：全站地毯式bug巡檢——8項發現，7項已修（1項為AI措辭已加強提示詞）

Opus agent實測正式站（未測已修過的關注清單/搜尋/AI問答/產業分類），找到8個問題，
依嚴重度修復：
1. **【高】美股個股頁現價落在當日最高/最低之外，漲跌幅跟/news對不上**：根因是
   `us.ts`的`fetchUsQuote()`用「close是不是null」判斷哪根K棒是「今天」——但Yahoo
   在盤中/剛收盤這段時間，今天這根K棒常常open/high/low已經有值、**close卻還是
   null**（後端要等一段時間才結算），原邏輯一看到close是null就跳過整根，誤把
   昨天當今天，導致open/high/low全部拿到昨天的數字，`price`卻仍是今天的即時值
   （來自`meta.regularMarketPrice`），連帶`prevClose`也多推一天。改用K棒自己的
   時間戳（`timestamp`陣列）跟`meta.regularMarketTime`的美東時間日期比對，才是
   正確的「這根是不是今天」判斷依據，不看close是否為null。用真實Yahoo資料驗證
   10檔美股（含8檔原本壞掉的）修復後全部`price`落在`[low,high]`區間內。
2. **【高】關注清單一旦非空，每一頁都噴React hydration錯誤**：`ChatWidget.tsx`
   在render階段直接呼叫`getWatchlist()`（不是`useSyncExternalStore`），SSR回傳
   `[]`、client端讀到真實清單，兩次渲染不一致。改用`WatchlistSection.tsx`已經在
   用的`useSyncExternalStore`+`WATCHLIST_CHANGED_EVENT`訂閱模式。
3. **【中】AI問答輸入框首次開啟被壓扁成21px**：自動增高的`useEffect`只依賴
   `[input]`，面板用`hidden`切換顯示（不是卸載重掛載）時，面板還隱藏的當下量到
   的`scrollHeight`是0，打開面板本身不會觸發重新量測。補上`open`依賴。
4. **【中】手機375px下「焦點排行」/「搜尋結果」表格產業欄被壓成一字寬直排**：
   `StockTable.tsx`原本沒有`min-width`，比照`WatchlistTable.tsx`加上
   `min-w-[720px]`＋橫向捲動提示。
5. **【低】使用者可見文案「試搓」應為「試撮」**：4個使用者可見字串＋3處程式碼
   註解，全部修正。
6. **【低】技術線設定選單點外部/按Esc不會關閉**：比照`SiteHeader.tsx`搜尋建議
   清單的既有做法，補上點外部/Esc關閉。
7. **【低】興櫃股票今日無成交時顯示「更新時間 00:00:00」**：`emerging.ts`的
   `fetchEmergingQuote()`/`fetchEmergingQuotesSnapshot()`在沒有真實成交時間可用
   時，原本硬套`taipeiStampToIso(tradeDay, undefined)`把時間部分補成00:00:00，
   看起來像凌晨成交的假時間。改成比照`twse.ts`批次快照的慣例，沒有真實時間時
   直接用「現在」（成功查到這筆資料的時間）。
8. **【低，AI措辭類，非決定性bug】`/action`出現語意不通的句子**：AI在術語解釋
   括號前自己加了一句過渡語（「股價淨值比等指標中，本益比代表...」）造成語句
   破碎。這類AI生成內容無法用程式碼「修好」保證不再發生，已在`actionBrief.ts`
   的系統提示詞加一條規則明講「括號解釋前不要自己加過渡語」，比照先前「0軸」
   措辭bug的處理方式（給AI一個明確可照抄的正確示範，而不是空泛地說「不要寫錯」）。

`tsc`/`eslint`/`build`皆通過。

### 2026-09-22：AI問答面板捲動位置修正

使用者反映問完問題AI回覆後畫面會跳到最下面（先看到答案結尾），且關閉面板再打開會跳回
最上面而不是保留原本位置。修法：捲動改成`scrollIntoView({block:"start"})`鎖定「最後一則
使用者訊息」，且在送出問題、答案渲染完成兩個時機都各呼叫一次（只呼叫一次會卡在答案還沒
長出來時的可捲動範圍上限，答案出現後不會自動修正）；面板從`{open && (...)}`（關閉會整個
卸載DOM、捲動位置歸零）改成一直掛著、用`hidden` class切換顯示，讓瀏覽器原生記住捲動位置。
本地Playwright實測：問完第二題後，問題泡泡離容器頂端只差-0.5px（近乎貼齊，800~3000ms多次
取樣皆穩定非動畫殘影）；關閉再打開前後捲動位置完全相同（1530→1530）。`tsc`/`eslint`/
`build`皆通過，已上線（`d3635c7`）。

### 2026-09-22：台指期夜盤白天空窗期修法正式驗證通過

08:46（白天空窗期內）直接curl正式站`/api/taifex-futures`，正確回傳最後一次夜盤收盤快照
（`status:"closed"`，`asOf:2026/09/22 04:59:58`），不是「資料暫缺」，確認2026-09-21那次
修法生效。這一項正式結案。

> **更早的工作日誌（2026-09-21 及以前，含2026-09-21整天的「/api/indices」根治、關注清單
> 報價暫缺改造、AI推薦名單多面向整合、ask.ts/data/index.ts大檔案拆分、PROGRESS.md分割
> 本身、以及更早的興櫃收錄、TPEx擴充、GitHub私人repo擋部署、今日建議改版等功能的完整
> 開發紀錄）已搬到同目錄的 `PROGRESS-ARCHIVE.md`，只有需要查很久以前某個功能當初怎麼
> 做的細節時才需要打開它，平常接手不用每次都讀。已經做過三次搬遷（2026-09-21 當天兩次、
> 2026-09-27 一次），起因都是主檔又長回大幾百行以上、單次讀取成本疊加得太快。**

## 目前已知問題

- **【金鑰已於2026-10-01加入Vercel；待美股開盤後實際驗證】Adanos 社群情緒**（開盤前實測：小卡誠實顯示「資料暫缺（美股盤中才會更新）」不破版）。
  加上後第一份快照要等美股盤中（台北約21:30~04:00）有人開美股個股頁/問AI才會抓；三個來源要約80分鐘才會都有資料。
  若要查用量：Redis key `adanos:quota`（伺服器回報剩餘）、`adanos:calls:day:<紐約日期>`、`adanos:calls:month:<UTC年月>`。

- **【金鑰已於2026-10-01加入Vercel，AI問答正式站6題複查通過】AI備援（NVIDIA／Groq）**（正式站無法強制Gemini失敗，備援切換只在本機用假金鑰驗證過）。
  已知限制：NVIDIA 單股/關注清單深度分析偶爾超過40秒逾時（變異大，實測29~44秒），Gemini 本身逾時時 NVIDIA 剩餘時間不足；
  Groq gpt-oss 偶發回空白內容（會自動落到下一家）。
- **【評估後不做】Tavily 網路搜尋補充**：本站「沒資料」最常見是未收錄的主題/概念股，而既有規則刻意禁止列未查證成分股，網路結果（部落格/FB）
  正是該規則要防的來源；實測10筆結果約4筆低品質（房地產站、亂碼頁、FB）；每月1,000次全站共用，且 ask 幾乎每題都有 grounding，
  沒有可靠的「完全沒資料」觸發訊號。若日後要做，建議改成使用者主動按「上網查」＋網域白名單（官方IR/公開資訊觀測站/主流財經媒體）。

- **【待確認，約2026-10-04後】列表「大戶持股(週)」長列表升降目前全顯示「累積中」**：本站週快照9/30才開始累積，要等集保CSV下一次換週（約10/3公布）才有上一週；屆時抽查`/search`該欄應出現▲▼，若仍是累積中就查`major-holders:TW:weeks:v1`是否有兩週。
- **【已於2026-10-01修好，正式站Playwright驗證通過】部分股票K線圖渲染時噴 pageerror「Value is null」**：根因是 TWSE STOCK_DAY 對無一般成交的日子回開高低收 `"--"`→NaN→null；資料層（`candleSanity.ts`）與 `StockChart.tsx` 兩層都已過濾，詳見工作日誌 2026-10-01。
- **【已於2026-10-01修好，Opus正式站複查通過，結案】手機版個股頁「籌碼比例」不在第一屏**：已移到價格正下方、開高低收格子之前（`71ba49d`，LiveQuoteHeader 新增 afterPrice slot）；複查：2330 手機版區塊頂端在467px（畫面高844），第一屏看得到。
- **【已於2026-09-27修好，Opus正式站複查通過，正式結案】K線圖快速切換到/離開「當日」區間時偶發console錯誤**：
  根因是`chartData`的時間格式判斷用即時`range`，但`candles`資料在新range fetch完成前
  刻意保留舊range資料——快速切走「今日」時會用新range的daily格式去解讀還沒更新的
  intraday資料，餵給lightweight-charts格式不符的時間字串而噴錯。修法：新增`candlesRange`
  state跟`candles`同時更新，格式判斷改用「candles實際對應的range」。`tsc`/`eslint`/
  `build`皆通過（`d3c2268`）。
- **【已於2026-09-22修好】亂碼/雜訊文字可能被誤判成美股單一字母代號**：
  Opus驗證agent測試時不小心用錯編碼送出亂碼問句，發現系統會從亂碼裡抽出孤立大寫字母
  當成美股代號（例如誤抽到S/O/L/J分別對應SentinelOne/Realty Income/Loews等），然後
  完整分析一檔完全不相關的美股。根因是`symbolResolve.ts`的`SYMBOL_PATTERN`允許1個字母
  就成立代號。修法：改成至少要2個字母才算數（`{1,5}`→`{2,5}`）；代價是T/F/V/C/D/O
  這幾檔本站收錄的真實單字母代號，改成只能用公司名稱查（Visa／Ford等），不能只打
  裸代號——真人在中文語境裡本來就幾乎不會單獨打一個字母指名股票，這個犧牲換取徹底
  排除亂碼誤觸發的風險。`tsc`/`eslint`/`build`皆通過。**Opus複查通過**：故意用會產生
真實單字母代號（O/C/T/V）的亂碼測試，修復後完全不再誤觸發無關美股分析；用公司名稱查
AT&T／Visa正常；裸代號「V」如預期查不到（不再誤認成Visa）；AAPL／TSLA等2字母以上
代號不受影響。正式結案。

- **【已於2026-09-21修好，2026-09-22白天空窗期已實際驗證通過，正式結案】台指期夜盤卡片
  白天約10小時曾顯示「資料暫缺」**：根因是交易所`mis.taifex.com.tw`夜盤盤面端點在非夜盤
  時段（約05:00~15:00）會把每一列`CLastPrice`清空成空字串，`fetchTaifexNightFutures()`
  照規則正確回傳null。已新增24小時長效快照，即時抓取為null時改讀最後一次真正成功的快照
  當退路並強制設成`status:"closed"`。**2026-09-22 08:46（白天空窗期內）直接curl正式站
  確認**：`/api/taifex-futures`正確回傳最後一次夜盤收盤快照（`"status":"closed"`，
  `"asOf":"2026/09/22 04:59:58"`），不是「資料暫缺」，修法生效。這一項正式結案。
- **【2026-09-20 新增，興櫃收錄的殘留事項，其中第 1 項是必須做的驗證】興櫃（Emerging）已完成收錄**，
  詳見上方 2026-09-20（續五）工作日誌。`src/lib/data/emerging.ts`，報價/K線/月營收/季報EPS 都有，
  睿信 7893 等 363 檔興櫃股票在搜尋框、個股頁、AI 問答都查得到，正式站已驗證。剩下這幾項：
  1. ~~**盤中即時性還沒驗證**~~ → **已於 2026-09-22 交易時段內正式驗證通過，結案**：對正式站
     `/api/quote/<代號>?market=TW` 連續查詢 6696 仁新、7729 仲恩生醫、6618 永虹先進三檔活躍
     興櫃股，間隔75秒、共12輪、橫跨09:34:55~09:49:36（約15分鐘）。三檔的`updatedAt`皆隨查詢時間
     同步往前走、成交量單調遞增（例：6696 從5,138,749股漲到7,138,061股，價格178.5→186）、
     價格也持續變動，證實是真即時資料，不是盤後快照。未發現需要修的 bug，程式碼未變動。
  2. **興櫃刻意不進排行榜/搜尋篩選頁**（無漲跌幅限制+流動性極低+風險高，會洗版並誤導），
     這是產品決策不是 bug，理由寫在 `universe.ts` 的 `capUniverse` 註解裡。
  3. ~~**盤中/收盤狀態徽章對興櫃不準**~~ → **已於 2026-09-20（續七）修正**（`2863576`，詳見下方
     工作日誌）：新增 `MarketScope = Market | "TW-EMERGING"`，興櫃走自己的 09:00~15:00 時段，
     個股頁徽章、輪詢節奏、關注清單/到價提醒的逐檔判斷都已跟上；上市櫃/美股行為未變動
     （54 項純函式測試 + 正式站假時鐘實測回歸皆通過）。
  4. **興櫃沒有的資料**（不是抓取失敗，是櫃買中心根本沒公布）：本益比/殖利率/股價淨值比、
     三大法人買賣超、融資融券（依規定興櫃不能信用交易）、每日重大訊息、內外盤。個股頁這幾張
     卡片對興櫃會顯示「資料暫缺」，AI 也會誠實說沒有。
  5. **興櫃季報 EPS 只收了「一般業」**（`mopsfin_t187ap06_U_ci`），金融/證券期貨/金控/保險/異業
     的興櫃公司查不到 EPS——跟上市櫃那邊同樣的限制、同樣的原因。
  6. **K線來源是 Yahoo `.TWO`**（櫃買官方的興櫃歷史行情沒有開盤/收盤價，只有均價，拿來畫K棒
     只能憑空補；Yahoo 的高/低/量已逐日核對跟櫃買官方完全一致）。這跟美股資料一樣是非官方
     端點，被鎖的話興櫃K線會變「資料暫缺」，報價不受影響。
- **【已於2026-09-21修好，2026-09-22盤中驗證通過，正式結案】台股候選池會間歇性大幅縮水**：
  `searchStocks({market:"TW", sortBy:"turnover"})` 曾在不同時刻分別回傳過
  **0 筆 / 50 筆 / 1535 筆**。根因是`getMarketQuoteMap()`背後跟同一天稍早修`/api/indices`
  漏抓TAIEX時發現的同一個上游/併發瓶頸（`mis.twse.com.tw`無上限併發會被靜默斷線），已用
  `MIS_BATCH_CONCURRENCY`限流+`cachedMapWithDegradedShortTtl()`（筆數低於universe規模
  一半只快取3秒）補強（`13a42dc`）。**2026-09-22盤中09:28~09:48（真實交易時段內）完成
  驗證**：每65秒取樣一次共18次，筆數在1833~1982之間波動，最低1833筆仍屬正常範圍，
  沒有出現30%以上驟降，跟先前盤後13次連續1982筆零變異的結果一致。盤中負載下確認穩定，
  正式結案。
- **【已於2026-09-21修好】MACD 的 EMA 種子改成教科書標準 SMA 種子**：`signals.ts`跟
  `indicators.ts`各自獨立一份的`ema()`（前者供技術訊號標籤/多重指標篩選，後者供圖表MACD
  副圖，兩份已同步改成完全相同算法）原本用`values[0]`當種子，現改為「前N根SMA」當種子，
  消除EMA26暖機偏差造成的臨界交叉差一天問題。前置不足根數的點誠實回null（不編數字），
  `computeMacdCross`加上null防護避免undefined靜默判成「沒有交叉」。`tsc`/`eslint`/`build`
  皆通過；另外寫了一份獨立的教科書標準MACD參考實作拿真實K線交叉比對，2330/2454判定結果
  跟網站畫面完全吻合；正式站部署後額外確認先前記錄的臨界案例聯詠(3034)輸出正常無異常
  （「今天MACD沒有發生交叉，MACD線位於0軸上方」，無NaN無錯誤）。這一項正式結案。
- **【2026-09-20 新增，2026-09-21 已根治且已完整驗證】關注清單的股票會因為單一報價請求失敗
  而整列消失**：根因是 `WatchlistSection.tsx` 的 `onFetch` 對抓失敗的那一檔回 `null`，那一檔
  就整列不在表格裡。現已改成回「報價欄位全為 null 的佔位列」、畫面顯示「資料暫缺」，詳見上方
  2026-09-21（八續）工作日誌。**台股版混合情境已補驗證**：用 Playwright 攔截正式站 2330 的
  報價回 500、2454/6811 正常放行，結果 2330 顯示「資料暫缺」、2454/6811 顯示正確即時數字，
  跟之前只驗過的美股版行為一致，這一項正式結案。
- **【2026-09-20 新增，判定可忽略】搜尋框在頁面 hydration 完成前按 Enter 會重整首頁**：
  實測時間窗 < 500ms（桌機、快網路），真人點擊＋打字＋按 Enter 不可能這麼快，所以沒有處理。
  若之後真的要做 progressive enhancement，做法是給搜尋 `<form>` 加 `action`/`name`，並讓
  `/search` 頁讀 URL 上的 `q` 當初始關鍵字（目前 `SearchClient` 不讀 URL 參數）。
- **【2026-09-20 新增，已完成範圍內驗證，無殘留問題】「今日建議」頁改版（`/action`）**：
  詳見上方 2026-09-20（續三）那則工作日誌。正式站實測抓到 8 個輸出品質問題（簡體字/日文
  漢字、術語白話解釋只做一半、技術面「無資料」措辭誤導、「投信買超0張」、正負號中文化成
  「為加24.85%」、編造「全球主要央行同步升息」、反例挑了只漲4.98%的股票當「漲很多」、
  **AI 自己加嚴門檻把合格標的全部排除誤寫成建議觀望**），分五輪修完並各自在正式站重生驗證
  通過。最後連續兩次重生結果一致（都列出華邦電2344／南亞科2408／聯電2303 三檔建議買進，
  漲幅 5.59%~7.58% 全部不在漲幅榜前10；反例都是當天漲停 +10% 的股票），確認是穩定的而
  不是運氣。改版主體（明確「建議買進」用詞、不是漲幅榜照抄、跨面向理由帶實數字、漲停股被
  當反例點名、沒有夠格標的時會誠實觀望）全部確認正確，**沒有殘留問題**。三點供之後接手的
  人注意（都不是 bug）：(1) 驗證這一頁一定要用 `/api/action-brief?refresh=1`，否則 30 分鐘
  快取會讓你看到舊內容；(2) 建議標的的技術面常常是「沒有出現夠強的訊號」，這是門檻設計允許
  的結果（4 個面向裡有 2 個以上支持即可，技術面不是必要條件），如果之後使用者覺得「建議買進
  的標的至少要有技術面支持」，那是在 `QUALIFY_MIN_SUPPORT` 旁邊再加一條技術面必要條件的
  產品決策；(3) 這一頁每次重生的文字都不一樣，剩下的是純隨機的一次性筆誤（驗證期間出現過
  「今天台大盤」少一個字、「投信國內基金公司買超」漏了括號），規則救不了也不值得追。
- **【已於 2026-09-20 完成規則二獨立驗證，確認無bug】語音輸入（含手動停止＋輸入框多行
  textarea）**：詳見 2026-09-20「Opus驗證AI問答全部新功能」那則工作日誌。桌機1440×900與
  手機390px各18項、共36項全數通過：麥克風按鈕位置/可點擊、`continuous=true`模式下模擬
  停頓不中斷也不跳紅字、瀏覽器自行`onend`後自動重啟且畫面全程不中斷、辨識結果接在既有
  文字後面不覆蓋、手動停止後真的停且不再自動重啟、171字長文字完整保留並換行、面板不被
  撐爆、無橫向捲動。這一項正式結案。**已知限制維持不變**：沒有真麥克風可測「真實瀏覽器
  語音引擎在多久靜音後才會自己onend」這個實際秒數/機率，以及Firefox桌面版/Safari/iOS
  支援度不穩定（刻意設計會提示改用打字，非bug），這兩點是瀏覽器本身能力範圍，不是本站
  程式碼能控制的。
- **【已於 2026-09-15 深夜完成 Opus 規則三獨立複查，確認修好】漲跌停鎖住的股票被誤判成
  0% 漲跌幅（`527ca9a` 內含，見上方「續」那則工作日誌）**：使用者以驊宏資 6148 回報。
  已修好 `twse.ts`/`tpex.ts` 的 `trade.z` 備援。Opus 於當日深夜用 Playwright 在正式站
  複查：6148 顯示 `37.50 / +9.97%`（昨收 34.10，確實是漲停鎖死而非 0%）、6811 顯示
  `251.0 / +1.21%`，兩檔都不是 0%，這一項正式結案。
- **【已於 2026-09-15 盤中完成獨立複查，確認修好】上櫃(TPEx)報價卡在昨天收盤的嚴重 bug
  （`3508788`、`7e8a7f7`）**：詳見上方 2026-09-15（盤中）那則工作日誌。6811 宏碁資訊的成交價
  與昨收都跟 Yahoo 股市完全相同（247.0 / 248.0），另外抽測 3105、3293、8069、6488 四檔上櫃股
  都跟 Yahoo 量級一致、昨收完全相同，2330 上市對照組不受影響；首頁焦點排行榜單已換血、
  原本卡住的 6811 正確地從漲幅榜消失。
- **【已於2026-09-22處理並經Opus瀏覽器複查通過】今天沒成交的冷門股會用委買賣中價算出
  漲跌幅並進入排行榜**：1385 檔台股裡有 145 檔「成交量 0 但漲跌幅不為 0」，例如 4911
  德英顯示 +3.60% / 量 0 張。修法：①`twse.ts`/`tpex.ts`的`rowToQuote()`成交量為0時
  附加`priceNote`；②`search.ts`的`searchStocks()`：照漲跌幅排序且沒有帶關鍵字查詢時，
  濾掉成交量0的股票，直接查詢該股票不受影響。**Opus瀏覽器複查第一輪抓到真bug**：
  `LiveQuoteHeader.tsx`原本把`priceNote`的渲染寫在`quote.board === "emerging"`的條件
  區塊裡面，導致上市/上櫃股票（board不是emerging）的揭露文字雖然API有回傳、HTML的RSC
  payload裡也找得到字串（先前curl grep誤判成通過的原因），卻完全沒有被渲染成畫面元素，
  使用者實際上什麼都看不到。已修正：把`priceNote`渲染搬成獨立區塊、不綁board，
  3632研勤複測畫面正確顯示揭露文字，排行榜過濾（1840筆濾掉146檔零成交）與直接搜尋
  都正常。`tsc`/`eslint`/`build`皆通過。**Opus複查（`fe44c49`）確認**：1315達新、
  3632研勤畫面各正確顯示揭露文字1次未重複；興櫃7893睿信的興櫃專屬說明區塊未受影響、
  正常顯示且不重複。正式結案。
- **【已於 2026-09-15 傍晚完成獨立複查，兩項都確認修好】首頁輪詢 + 快報開收盤措辭
  （`9ee3760`）**：詳見上方 2026-09-15（傍晚，續）那則工作日誌。焦點排行 `/api/search`
  與我的關注 `/api/quote` 都量測到精準 20 秒一次的輪詢；畫面數字會跟著更新（用攔截竄改
  API 回應的方式證明渲染路徑是通的，因為當下焦點排行第一名是漲停鎖死股、數字本來就不會動）；
  快報在台股盤中、美股已收盤的時段，措辭正確分成「盤中暫報」與「已收盤」，台股段落完全
  沒有出現「終場／收在」。
- **【已於 2026-09-15 傍晚完成獨立複查，7 項全數確認修好】Chrome Claude 地毯式測試抓到的
  8 個問題**：詳見上方 2026-09-15（傍晚）「規則三獨立複查」那則工作日誌，原始重現步驟看
  git 歷史裡的 `股情雷達測試報告.md`（commit `6c94725`，2026-09-20 已從根目錄刪除，8項問題皆已結案）。第 1-7 項都用 Playwright 實際驅動瀏覽器在正式站操作
  驗證通過（含第 7 項這次終於抓到 67 個「📄 全文摘要」實例，補上了上一輪缺的截圖驗證）；
  第 8 項骨架屏本來就不是真 bug。複查過程中另外抓到並修好一個新瑕疵（圖表「載入中…」提示
  被價格軸刻度蓋住，`StockChart.tsx` 加 `z-20`）。
- **【已於 2026-09-15 深夜完成 Opus 規則三獨立複查，確認修好】全台股上櫃(TPEx)股票報價
  卡在「昨天收盤」**：Opus 複查時抽測 6811、3105、8069、3293 四檔上櫃股，每一檔的
  開/高/低/收都跟昨收是不同的數字，而且 6811 的收盤價 251.0 跟同一天稍早記錄的盤中
  246.5 不同，證明盤中確實有隨時間更新；2330 上市對照組正常。這一項正式結案。
  以下保留原始記錄供參考。根因是 `lib/data/tpex.ts` 原本用
  的 TPEx 官方 OpenAPI 報價端點其實是盤後資料，已改用 `mis.twse.com.tw` 的 `otc_`
  前綴即時端點。部署後直接 curl 正式站驗證：6811 宏碁資訊從卡住的 `248/+9.98%/
  prevClose 225.5` 變成 `246.5/-0.6%/prevClose 248`，跟使用者提供的 Yahoo股市截圖
  （247.0/-0.40%）數量級一致；3105 穩懋（另一檔上櫃股）也是合理的即時數字；2330
  台積電（上市股）不受影響、正常運作。已請 Opus agent 追加複查，尚未收到回報。
- **【2026-09-21 複查確認已修好，本條目先前是過時記錄】AI 問答「apple」小寫贅語**：這份文件
  一直記著「尚未處理」，但這次重新在正式站測了兩題（單純問股價、問技術面偏多偏空）都是乾淨
  的答案，完全沒有「另一檔『APPLE』查不到」這種殘留句子——推測是更早某次修正（`ask.ts` 的
  `matchedNameSubstrings` 追蹤機制）已經解掉了，只是這份「目前已知問題」清單沒有跟著更新。
  這一項正式結案，之後不用再提。
- **【已於 2026-09-15 完成 Opus 規則三複查，2個真實bug已修好】台指期夜盤（近月合約）**：
  詳見上方工作日誌。資料源是 TAIFEX 官方免費看盤網站 `mis.taifex.com.tw/futures/`，
  跨午夜時間戳倒退、AI 誤把最新價講成漲跌點數這兩個 Opus 複查抓到的真實 bug都已
  修好並在正式站驗證過。**已知的資料源限制**：`mis.taifex.com.tw` 這個端點是該
  網站前端自己的內部 API，不是 TAIFEX 正式對外公告的公開 API 規格（不像 TWSE
  OpenAPI 那樣有官方文件），理論上該網站改版時可能連端點名稱或參數格式一起換掉，
  屆時會需要重新用同樣的手法（下載該網站的 JS bundle 找新的呼叫方式）排查，這是
  使用非官方文件化端點的常見取捨。
- **【已於2026-09-21根治，見常見雷區索引】`/api/indices` 偶爾漏掉TAIEX**：根因是
  全市場批次報價對`mis.twse.com.tw`無上限併發（約40個同時連線）會讓上游靜默斷線，
  且失敗被當正常結果快取整個TTL。已修好，細節見下方索引與工作日誌。
- **【已於2026-09-21修好】`StockChart.tsx` 的 `react-hooks/set-state-in-effect` lint
  警告**：技術線設定改用 `useSyncExternalStore`（比照 `lib/watchlist.ts` 的
  `getWatchlist()` 快取模式），原本的警告已消除，並用本機Playwright驗證切換技術線
  checkbox正常、設定正確持久化、無console錯誤。複查時額外發現同一檔案還有第二個
  既有的set-state-in-effect（圖表資料fetch的`setIsLoading(true)`）——這個是真正
  「effect裡啟動非同步操作」的合理用法，沒有對應的external-store改法，已加
  eslint-disable-next-line並說明原因，不強行改動運作正常的抓取邏輯。

**【2026-09-15 更新】現況：2026-09-15 這一整天（第一續～第九續，見上方工作日誌）做的
一大批功能/修正——字體字級調大、關注名單投資金額/損益平衡價/持有排序/購買價格0導致
crash的修正、AI關注清單深度分析、個股頁「問AI關於」按鈕深度分析、成交金額顯示/篩選/
排序（中文單位）、個股頁內外盤卡片、08:30-09:00試搓標示、以及最後三輪跟玉山證券App
反覆核對出來的手續費捨去整數元+損益平衡價無條件進位公式修正——**已於 2026-09-15 深夜完成 Opus 規則三獨立複查，
10 項全數確認正常**（詳見工作日誌最新一則：字級/版面 7 頁 ×2 尺寸掃描 0 溢出、
ChatWidget 4 種尺寸完整顯示、拖曳排序與分組與總計與購買價格填 0、AI 兩個深度分析按鈕
逐一核對約 30 個數字零捏造、成交金額顯示/篩選/排序、內外盤定義與顏色、盤前試搓用假時鐘
重現、成交量與價量關係篩選、6148 漲跌停、TPEx 四檔報價）。複查過程中另外抓到並修好
1 個缺口（關注清單「匯出 CSV」沒跟上改版、漏掉持股與損益欄位，`aa192bf`，已在正式站
驗證）。**這一整批到此正式走完規則二＋規則三的完整品保流程。**除此之外沒有已知未修的 bug；今日建議頁、技術訊號布林通道/KD/均線排列/
MACD 0軸判讀、AI 問答新手化+整合更多面向，以及更早先 Opus 規則三挖出的各批問題都已經
驗證過也已經派 Opus 複查確認修好，流程走完。以下只列**還沒做、但已經評估過、之後有
需要再處理**的項目：

- **【已於 2026-09-15 深夜完成 Opus 規則三獨立複查，確認正常】搜尋頁成交量篩選＋
  「價量關係」偏多/偏空篩選**：詳見上方工作日誌同日期那則。Opus 複查結果：成交量
  ≥5 萬張篩選從 1977 筆縮到 12 筆；「價漲量增（偏多）」篩出 44 筆、每一筆都是上漲且
  帶徽章，「價跌量增（偏空）」篩出 28 筆、每一筆都是下跌且帶徽章，語意完全一致；UI
  文案確認有明講「不是真實的委買委賣單成交量統計」。**下方那個「還沒在正式站親眼確認
  會顯示 buy-leaning/sell-leaning」的待辦，這次一併補上了**——均量歷史已經累積足夠，
  正式站真的會顯示這兩種徽章，不再是全部「量能不明顯」。**這是傳統技術分析的「價漲量增/
  價跌量增」價量關係推論，不是真實的委買委賣單成交量統計**——本站沒有任何資料源
  提供逐筆成交方向（內外盤）資料，這個限制務必保留在 UI 文案跟這份文件裡，之後
  誰都不能把它改寫成聽起來像真實買賣單資料的說法。**已知的冷啟動限制**：均量
  歷史（`volume-history:{market}:v1`）要靠正式站實際跑過至少 5 個真實交易日才會
  開始出現非中性的分類，剛部署的頭幾天大部分/全部股票會顯示 `volumeTrend:
  "neutral"`（均量資料不足，誠實顯示無訊號，不是 bug）；已用暫時 seed 進假快取
  的方式驗證過分類邏輯本身正確（見工作日誌驗證段落），但**還沒有在正式站等到
  真實累積 5 天以上資料後，親眼確認正式站上真的會顯示 buy-leaning/sell-leaning**
  ——接手的裝置如果距離這次部署已經過了幾個交易日，可以直接上正式站
  `/search` 頁面確認有沒有出現「價漲量增/價跌量增」徽章來補上這一步驗證。
- **【已於 2026-09-14 完成，見下方工作日誌】TPEx（上櫃）股票已涵蓋**：新增 `tpex.ts`，
  報價/K線/基本面/月營收/季報EPS/三大法人/融資融券/重大訊息/公司清單全部比照 twse.ts
  規模建置完成，並整合進 `universe.ts`/`index.ts`。正式站部署後連續踩到三個獨立根因
  （TLS憑證鏈缺中繼憑證、TPEx大檔案端點偶發回應不完整、universe快取沒區分成功/降級
  結果的TTL），詳見下方工作日誌的除錯記錄；三個都已修好並在正式站反覆驗證：3293/
  6274/6488 各自間隔21秒連續測5次報價（15/15成功）、搜尋結果792筆正確包含這些
  股票、AI問答對這幾檔用中文全名跟代號測共6次全部正確回傳真實資料。**「興櫃」當時
  明確排除在範圍外，但已於 2026-09-20（續五）另外做完**（見上方該則工作日誌與本章節
  第一條，資料來源確實跟上櫃完全不同，是另一套 `emerging.ts`；AI 問答原本那句「不含
  興櫃」的說明文字也同步改掉了）。**殘留的已知限制**：TPEx 的
  `tpex_mainboard_quotes` 端點本質上是「每個交易日更新一次」，不像 TWSE MIS 那樣
  盤中逐筆更新，所以 TPEx 股票的報價在當天盤中不會像 TWSE 股票一樣即時反映最新
  成交，這是 TPEx 這個免費公開端點本身的資料時效性限制，不是程式邏輯的問題。
  另外，TPEx 大檔案端點的不穩定性雖然已經用「Content-Length比對+Range續傳+整體
  重試」大幅緩解，但終究是對治標不治本的折衷（真正徹底的解法是更完整的分段下載
  重建機制），如果之後實際使用時仍常遇到 TPEx 資料暫缺，可以往這個方向再加強。
- **8 大面向框架裡還沒做的 4 塊**：法說會逐字稿與管理層前瞻、終端需求與供應鏈
  （DIGITIMES）、總體經濟與政策（FRED 等，需要免費註冊金鑰）、期權與衍生性商品
  （TAIFEX）——這四塊目前完全沒有資料管道，各自都是獨立的新工程，可靠的免費爬取
  方式也還沒驗證過（尤其法說會逐字稿、DIGITIMES 供應鏈資料的取得管道不明確），之後
  如果要做，需要先個別評估可行性再動工，不是能直接套用既有模式的小改動。
- **重大新聞頁的來源多樣性受限於 Google 新聞 RSS**：目前查 12 個主題關鍵字去湊新聞量，
  這仍然是「Google 新聞收錄了什麼」決定的範圍，不是真正對接每一家財經媒體的獨立來源；
  如果之後想要更完整/更即時的新聞覆蓋（例如即時股價異動快訊），Google 新聞 RSS 這個
  免費來源本身就有上限，需要另外評估付費新聞 API。目前這個範圍對「重大消息不遺漏」
  這個需求來說已經足夠，不是急迫問題。
- **置頂分類完全依賴 AI 單次判斷，沒有二次確認機制**：目前每次重新產生（20 分鐘 TTL）
  都是獨立呼叫一次 AI 判斷置頂，理論上不同次呼叫對「邊緣案例」（介於重大消息跟一般消息
  之間）的判斷可能不完全一致，這是文字生成模型本質上的變異性，不是 bug；只要確認 AI
  沒有把明顯的個股新聞誤判成大盤級消息（已驗證過一次），就符合設計預期。

- **US 財報資料源是非官方 Yahoo 端點**：`fetchUsEarnings`（`us.ts`）用的 quoteSummary
  跟批次報價一樣靠 crumb+cookie 認證撐著，Yahoo 之前已經無預警鎖過一次 `v7/finance/quote`
  （見工作日誌），這類端點理論上隨時可能又被鎖。如果哪天 AI 又開始說查不到美股財報，先檢查
  是不是 Yahoo 又改規則，不要照舊邏輯除錯。**使用者已表示如果需要可以去申請免費 API**
  （Alpha Vantage 或 Finnhub，見上方工作日誌「AI 問答新增真實新聞與財報資料」那則），目前
  還沒有這麼做，是可選的加強項，不是必要修正。
- **台股季報 EPS 沒有涵蓋金融/保險業**：`fetchTwseQuarterlyEpsAll` 只用了 TWSE 的
  `t187ap06_L_ci`（一般產業綜合損益表代號），金融/保險業 TWSE 用不同的報表代號，這次沒有
  另外接。銀行股/保產股問財報會查不到 EPS（月營收也一樣沒有，金融股本來就不對外公布月營收），
  這是資料源本身分類造成的限制，不是 bug，符合「查不到就誠實顯示沒有」的原則。
- **到價提醒目前只有網頁內顯示**：使用者已知情，之後要接 LINE 通知的話，需要 LINE
  Notify/Messaging API 的串接（這個需要使用者申請 LINE 開發者帳號跟 channel token），目前
  還沒開始做，是使用者自己說「先做網頁內顯示」時就講好的第二階段。
- **台股清單上限 1200 檔（上市）+900 檔（上櫃）、美股約 171 檔手動優先清單，仍非完整市場**：
  這是刻意的取捨（見 `universe.ts` 註解；上市上限已於 2026-09-15 深夜那次工作日誌從
  500 調高到 1200，這裡的數字先前沒有一併更新，特此更正），不在這個範圍內的極冷門股/
  美股查不到是預期內限制，不是 bug。

## 這次的環境變化（給下一個接手的裝置參考）

這是第一次在**這台本機 Windows PC**上執行這個專案的品保流程，跟先前 PROGRESS.md 記錄的「sandbox
連不到正式站、沒有 Playwright」不同——**這台機器對外網路正常、能連到正式站**，且已經：
- 用 `winget install OpenJS.NodeJS.LTS` 裝好 Node.js（LTS，含 npm）。
- 在系統暫存資料夾（非專案內）裝了 `playwright` npm 套件 + Chromium，可以真的用瀏覽器打開正式站
  點擊操作，不用再退而求其次只用 curl。
- 專案本身 `npm install && npm run build` 在本機也能正常跑，可以先在本機建置驗證再 push。
- **git push 第一次卡在 Git Credential Manager「Select an account」視窗**：這台機器的 Windows
  認證管理員裡存了兩個 GitHub 帳號（`andyzheng-art` 跟這個 repo 真正的擁有者 `hj110b13-Andy`），
  GCM 沒辦法自動判斷要用哪個，所以每次都跳出來問。已經把 `origin` remote URL 改成
  `https://hj110b13-Andy@github.com/hj110b13-Andy/Stock-web.git`（明確指定帳號），之後在這台機器
  上 push/fetch 都不會再跳出選擇視窗。**如果又跳出來（例如帳號密碼過期），跟使用者說一聲請他選一次
  就好，不是程式碼問題。**
如果下一個接手的裝置也是這台本機，以上工具跟 remote 設定應該都還在，不用重新安裝/設定；如果是
別的環境，仍比照舊有說明評估該環境的網路/工具限制。

**2026-09-11 後續更新：這台機器的專案 `node_modules` 跟系統暫存資料夾裡的 `playwright` npm
套件，實際上並不會一直保留**——這次同一天的對話裡，重新接續時發現 `node_modules` 整個不見了
（`npm run build` 直接報 `next` 找不到），Playwright 的 npm 套件（不是瀏覽器執行檔本體）也
一樣消失了，兩個都要重新 `npm install`。瀏覽器執行檔本體（`%LOCALAPPDATA%\ms-playwright`，
這台機器目前的實際使用者資料夾是 `C:\Users\HCY\...`——**這裡原本寫的是另一個帳號
`C:\Users\88691\...`，是舊筆記留下的錯誤路徑，2026-09-21 順手修正，之後不要照抄舊路徑，
一律用 `%LOCALAPPDATA%\ms-playwright` 或直接查當下的 `$LOCALAPPDATA` 環境變數**）目前看來
比較持久，但版本可能跟新安裝的 `playwright` npm 套件對不上（曾經
發生新套件要 chromium-1243、本機只有 chromium-1234，要多跑一次 `npx playwright install
chromium` 重新下載，約 1-2 分鐘）。**結論：不要假設上一輪裝好的東西這輪還在，每次開始品保
流程前先跑 `npm run build` 確認能不能動，不能動就照上面步驟重裝，不用大驚小怪。**

**測試腳本如果 payload 含中文，一律用檔案不要用 shell 內嵌字串**：這次對話裡两次獨立撞到同一
類假警報——用 `curl -d '{"question":"中文問題"}'` 這種內嵌 JSON 字串的寫法，在這台機器的
Windows Git Bash 環境下，中文字元偶爾會被錯誤編碼，讓問句裡憑空混入不存在的英文字母，導致
`guessSymbolFromText` 誤判成某個美股代號，測出一個其實不存在的「bug」（分別測到過 `H`
Hyatt Hotels 跟 `E` Eni 這兩個誤判，都跟真正提問內容完全無關）。兩次都是換成
`--data-binary @檔案路徑`（檔案內容用 Write 工具寫成 UTF-8）之後問題就消失，證實是測試方法
的編碼問題，不是網站程式碼的 bug。**之後任何裝置（包含派出去的 Opus/其他 agent）在這台機器
上寫含中文的 API 測試，都要用檔案 + `--data-binary @檔案` 的寫法，不要用 `-d '...內嵌字串'`，
避免浪費時間追查根本不存在的假 bug。**

**2026-09-23：這台機器已裝好 Playwright MCP，之後派QA agent不用再各自手刻瀏覽器操作腳本**：
今天連續好幾個Opus驗證agent都各自回報「沒有Playwright MCP工具可用，改用專案內的Playwright
以腳本方式驅動」，代表在此之前這台機器只有裸的`playwright` npm套件、沒有把它包成MCP
工具讓agent直接呼叫，每次都要重新寫一份`page.goto`/`page.evaluate`之類的腳本，浪費時間也
容易手滑寫錯。已經用`claude mcp add playwright -- npx @playwright/mcp@latest`（local
scope，這台機器＋這個專案）裝好官方Playwright MCP伺服器，`claude mcp list`確認已連線
（Connected）。**之後派瀏覽器驗證/測試類的agent，可以直接在指示裡提到「你有Playwright
MCP工具可以用」，讓它優先用MCP工具操作（例如`browser_navigate`/`browser_click`/
`browser_snapshot`這類），不用自己重新架設Playwright腳本環境**；如果agent回報還是說沒有
這個工具，先用`claude mcp list`確認連線狀態是不是掉了，不用假設是agent能力問題。

如果你接手後又發現了新問題，**除了修正之外，記得也在這份文件的「工作日誌」補一筆，並更新這個章節。**
