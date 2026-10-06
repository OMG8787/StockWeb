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
- **AI 問答講出不存在／錯誤的公司名稱，或說「沒有讀取持股的權限」**：前者是只給代號時模型自己猜名稱（5274 被講成「宏觀電通」），一律附本站清單查到的真名；後者是關注清單為空不是權限問題。→ PROGRESS-ARCHIVE.md 2026-09-22，搜尋「幻覺公司名稱」。
- **AI 說「系統沒有保留昨天的指標、無法回溯」或為使用者說的「你早上說過」道歉**：指標是日K現算的，個股資料要附「近5個交易日逐日交叉紀錄」，並有規則禁止承認無法驗證的先前說法。→ 工作日誌 2026-10-04，搜尋「近5日逐日」。
- **改了資料格式／標籤，正式站卻還顯示舊的**：整包資料表有 Redis 長效快取＋SWR 寬限期，舊格式會沿用到過期；改格式時要同時把快取 key 升版（例：`earnings:TW:eps:v2→v3`）。→ 工作日誌 2026-10-04，搜尋「EPS快取鍵升v3」。
- **台股季報 EPS 看起來異常大**：官方 t187ap06 的 EPS 是「當年度累計到該季」不是單季，標籤統一由 `data/earningsLabel.ts` 產生「Q1～Qn累計」。→ 工作日誌 2026-10-04，搜尋「累計」。
- **環境變數裡有付費服務金鑰就被自動使用**：按量計費的供應商必須另有 opt-in 開關（Claude 需 `ALLOW_PAID_AI=true`）；新增服務前先確認免費。→ CLAUDE.md「專案最高原則：零花費」。
- **GitHub Actions 預熱排程沒照「每5分鐘」跑**：免費排程常延遲數小時或丟棄，不能當主力；主力是 SWR（過期先回舊資料、背景重算），預熱改由 cron-job.org 觸發，回應期限 25 秒以配合其 30 秒逾時。→ 工作日誌 2026-10-04，搜尋「cron-job」。

## 接手狀態（CLAUDE.md 規則十；隨時更新，最後更新 2026-10-06 14:35 台北）

**進行中／暫停的工作（2026-10-06 14:30 額度將滿時存檔）**
1. ✅ 評測改前改後比較（10/6 晚我自己循序跑完）：33 題，規則通過率 gemini 97→99%、nvidia 95→97%，全部通過題 26→31／23→26；評審分略降（2.88→2.79、3.27→3.21，僅參考）→ 保留 `51b4087`／`976672c`。報告 docs/eval/2026-10-06-eve-compare.md。Stock-web-baseline 已刪（先 `rmdir` 掉 node_modules junction 再刪資料夾）。
2. ✅ 評等穩定化＋把握程度＋持有字樣＋評等變動說明：**已上線 `e169654`**（評測舊 3 題／新 6 題全過；持有中出場參考改「收盤跌破就出場」；正式站抽測：關注分析每檔單一動作、和益顯示「需連 2 交易日確認、今天維持前一交易日結論」；「全部股票有把握高的嗎」正確答 0 檔高、5 檔中）。注意：把握程度「高」需建議買進連續≥3 交易日，rating-confirm 剛上線，前幾天多半只有「中」。部署後第一次問全市場題可能因冷快取答「名單暫時讀不到」（8 秒逾時），再問一次即可。wt-stab 已刪。
3. 報價＋全站自動刷新（Sonnet）：自動刷新已上線（PageAutoRefresh、autoRefresh.ts）；`033b8b5` 批次失敗再試；`a32ec8e` 導覽／列表 prefetch 關閉——**待驗換頁速度**（各頁 5 秒內），變慢就改成只關列表連結。可能有 scratchpad/quote-wip.patch。10/7 盤中：量資料年齡、測 MIS「依 ex_ch 字串各自快取」假說。
4. 關注清單「已賣出」（Sonnet）：已上線 `a339401`（部署狀態見 git log 後 gh statuses），本機 Playwright 14 項過，**待正式站驗證**。
5. AI 模擬投資組合：已完成（`3e33491`、`cea32ce`、`c1e0bf2`、`1d39da4` 真實化、`10290a0` 永久保存）；待 14:35 結算時點確認封存寫入與盤後定價結算；10/7 盤中確認五檔成交價與漲跌停判斷。

**10/6 晚間新增（使用者 17:08～18:52 回報，已查證）**
- ✅ 首頁順序：大盤指數移到快報下、關注名單移到 AI 模擬上（`9ceb8f7`）。
- ✅ 模擬組合對照 0050／加權是「自建倉當下價格起算」，第一天與當日漲跌不同 → 標籤與說明註明（`9ceb8f7`）。
- ✅ 國巨「買進後曾漲到 732」錯：關注清單新增買進日期（股數 0→>0 自動記、可編輯、auto／user 標記、CSV 帶欄），停利只看買進日之後K線、沒有買進日不觸發（`9985425`，正式站驗證過）。**使用者的舊持股沒有買進日，要自己填才會判停利。**
- ✅（e169654 上線）和益早上建議買進、傍晚變先不要買：屬「評等隔日／盤中翻轉」同一類，評等穩定化分支（連 2 交易日確認）上線後解決；上線後要確認「盤中」也不會因單次資料翻轉（目前確認以交易日計）。
- ✅ 「有把握程度高的嗎?」不再綁上一則清單（e169654）；方法題（怎麼判斷放著或認賠、是甚麼門檻）不套用上一則股票，用程式組的本站判斷方式回答、模型沒講到就換程式版（`dfd10a9`、`70cc40e`）。
- ✅ AI 問答盤中用即時報價（`95ad717` withFreshLiveData）；「評等計算時間＋即時價」註記版本評測變差、不採用。

**排隊中（依序）**
1. 評測 agent 跑完 → 評等穩定化 B／C 評測與上線。
2. 四入口（今日建議／關注分析／個股按鈕／直接提問）品質比較：eval 新增四題型同批股票比較評審分數與規則通過率，最優做法套到其他入口，改後再比。
3. AI 問答盤中資料準確度：AI 回答時強制即時報價（目前非輪詢請求可能拿到數分鐘前的價）、評等價（10 分鐘快取）與即時價對齊、前一日籌碼資料標明日期。
4. 每次提示詞／AI 流程改動後跑跨模型評測。
6. **把握程度由程式算並優先排序（使用者 14:10 要求，交評等穩定化 agent 追加）**：ratingCore 定義可回測的把握程度（高／中／低），今日建議／全市場推薦／關注分析／技術篩選依把握程度排序並顯示，問答「把握高的」直接用程式分級。
5. **關注清單「已賣出」分組【已上線 `a339401`，本機 Playwright 14 項通過，等正式站驗證】（使用者 14:00 確認、已派 Sonnet）**：股數歸零→已賣出、價格也歸零→未持有；自動記賣出價／日期／股數／買進價（皆可編輯、可刪）；部分賣出也記一筆；顯示已實現金額與%、賣出後漲跌%與若沒賣差額、若沒賣%、天數、賣出當天本站建議；CSV 匯出入含賣出紀錄（舊格式相容）；AI 關注分析附已賣出區塊；跨裝置同步這次不做（手邊工作完成後再做）。追加（14:20）：四欄位各帶 auto／user 來源標記，使用者改過的值為準且不被覆蓋；auto 欄位標「估計」並提示確認；改賣出日期且價格仍 auto 時改用該日收盤價並重查當天建議；未確認紀錄在彙總與 AI 區塊標「估計值」分開計；CSV 帶標記。

**排定的觀察／檢查**
- 每則使用者訊息：check-feedback.py＋check-rating-log.py（上次 UTC 見下一章）。
- 2026-10-07 07:50～08:30：盤前名單是否穩定（actionStability.ts）、log「[action-list] 輸入不完整」是哪個上游。
- 2026-10-07 盤中：報價資料年齡改後量測（10/6 最後一輪仍 5～139 秒）；測 MIS「依 ex_ch 字串各自快取快照」假說——ex_ch 加隨機不存在代號當快取鍵等變體能否拿到較新快照，再決定重試方式（報價 agent 若已結束要重派）。
- 2026-10-06 盤後：明日操作卡正常、遇到評等變動個股時確認有說明原因。
- 2026-10-06～10-10：首頁卡片是否還標示「較強模型額度用完」。
- 每週：評等成績（scripts/check-rating-log.py、/scoreboard）對照基準 20 日 +0.76%（t 1.80）。

**使用者提過、尚未開工的待辦（逐條）**
1. 融資融券組合判讀（漲跌×融資增減×融券增減，程式先算、三個 AI 功能都用、今日建議持股結構面計分）。
2. 伺服器端對話記憶（跨裝置記得過往對話）。
3. 走勢相似度搜尋（例：像和益一個月前的走勢）。
4. 從使用者 👍 的回答挑 few-shot 範例（Lite 下限的一部分）。
5. 8 大面向剩餘：法說會逐字稿、供應鏈、期權。
6. 到價提醒接 LINE 通知。
7. Google 登入跨裝置同步（程式已寫，需使用者在 Vercel 設 AUTH_GOOGLE_ID／AUTH_GOOGLE_SECRET）。
8. 用戶問題（13:13～13:28 回報）已交評等穩定化 agent 的 C 項：「沒進今日建議名單≠先不要買」、關注清單分析漏旺矽、「把握程度高」答非所問；「今天最推薦買哪幾檔」答「沒有任何建議買進」→已修（`2174d26`、`8bb1c0f`：評等讀不到時沿用名單字樣、名單逾時明講暫時讀不到；根因未能在正式站重現，屬推定）。

**使用者已做的決定**：停用的 Claude API 程式碼先保留（ALLOW_PAID_AI 不設）；不為疊加免費額度另開正式站金鑰（先觀察 3～5 天）；本機用獨立 Gemini 金鑰＋GEMINI_PREMIUM_LOCAL=true；Stock-web-baseline 資料夾用完可刪。

**等待中的外部條件**：本機 mis.twse 13:43 起再次封鎖（評測 agent 誤開兩個程序），評測與評等穩定化上線都卡在這裡。四個 agent 12:00 左右同時撞 session 上限，13:40 重置後已全部用 SendMessage 接續。狀態列用量檔已設定（規則十第 4 點）。

## AI 回饋檢查紀錄（CLAUDE.md「AI 回饋自動檢查」）

- 上次檢查時間（UTC）：2026-10-06T11:40:00Z
- **漏查兩筆（10/6 晚盤點全部 68 筆時發現）**：09:42 🛠「昨天推薦的波若威和宏璟今天似乎都不太樂觀，要確認是誤判還是要放著等幾天」、09:47 📝「分析關注名單建議買的很多，但直接問又說沒有建議買的」。根因：我把「上次檢查時間」記成比實際檢查晚的時間（01:50Z），中間 01:42Z／01:47Z 的回報被跳過。**改正：上次檢查時間一律記腳本實際執行當下的 UTC（用 `date -u` 取），不可四捨五入往後記。** 09:47 已由 2174d26／8bb1c0f／e169654 處理（名單≠評等、評等讀不到不當成沒有）；09:42 以評等紀錄說明（1 日結果是雜訊，看 5／20 日；把握程度上線後兩檔皆為中）。
- 2026-10-06 11:43～13:28（台北）8 筆：👍鴻華先進先不要買；📝「只建議買0050嗎」與上則一致、「這3檔」有接上文（使用者稱讚）；問題：①「這3檔分別建議買還是不買」AI 以「沒列入建議買進名單」推成先不要買，但個股按鈕顯示昇達科、鼎元、勤誠皆建議買進（查證屬實：名單≠評等）；②「今天最推薦買哪幾檔」答「沒有任何建議買進」（今日建議當時有 5 檔，待查是否評等批次逾時被當成沒有）；③關注清單分析漏旺矽；④問把握高卻回把握中。①③④交評等穩定化 agent C 項，②併查。
- 2026-10-06 09:29（台北，盤中）📝「關注清單每一檔分析」：使用者說「昨天建議我賣我才賣、建議我買我才買，今天又不一樣」。查證屬實（評等紀錄）：聯發科 10/5 先不要買／減碼→10/6 建議買進／續抱，陽明、長榮 續抱→減碼，聯電 續抱→減碼，多由單日三大法人買賣超翻向造成；另 AI 把程式的「減碼」寫成「停損／全部賣出」、虧損寫「獲利已吐回」、沒說明為何與昨天不同。→派 Opus：評等遲滯／確認機制（須回測超額不變差且翻轉次數下降才上線）、持有建議逐字一致、多檔回答附評等變動說明。另：使用者決定停用的 Claude 程式碼先保留。
- 2026-10-06 08:35～08:46（台北，盤前）使用者 3 筆：兩則 👍（宏璟建議買進、巨虹先不要買，內容與二分評等一致）；🛠「為什麼都看到 Gemini Flash Lite；較強模型今日額度用完」→查證屬實：08:30 今日建議由 Lite 退回撰寫。實測 gemini-flash-latest、3.5-flash 已 429（太平洋日配額被本機 agent 測試共用金鑰吃掉），3-flash-preview 可用但思考模型原時限只剩約 16 秒→本機一律不用非 lite＋時限放寬（`4d0d4ed`）。
- 2026-10-05 19:02～19:18（台北，盤後）使用者 9 筆，查證：①多則「太保守、優柔寡斷、都沒有建議買的」（實際模型為 Gemini Flash Lite；評等大量落在等回檔，擴大回測顯示等回檔組不比建議買進差）→評等改二分果斷結論、等回檔併入建議買進並附一個更好的參考買點；②Gemini 自動挑到 gemini-flash-lite-latest（最弱）→改模型偏好順序；③「那有MACD與KD都黃金交叉的嗎」被答成加權指數→篩選題優先於追問解析；④「建鼎呢?」錯字直接說查無→名稱近似比對、先猜並問「你是指健鼎嗎」；⑤快報太簡短抓不到重點、要前因後果並當學習資料→快報改因果結構＋存檔；⑥想讓 AI 記得所有裝置的過往對話→列待辦（伺服器端對話記憶）；⑦AI 自己操作 100 萬模擬投資組合、自己學習→列待辦；⑧手機版關注清單固定表頭（對話中提出）。①～⑤⑧已派 agent。
- 2026-10-06 00:11～01:01（台北）使用者 5 筆，查證屬實：①手機關注清單產業顯示不完整、上下滑會帶動左右；籌碼四欄要一鍵收合（關注／焦點／篩選，電腦手機，隱藏後重排不留白）；②焦點、搜尋也要凍結表頭與名稱欄→派 Sonnet 表格 UI；③「明天要買什麼」推南亞建議買進但昨天說不追高、同一則回答「建議買進」下一行「AI看法：調降一級（先不要買）把握高」並引用 RSI≥75 教訓→AI 判斷層暫不顯示（照樣記錄）、教訓依擴大回測更新、評等與前一日不同時要說明原因（交原 agent）；④「美國伊朗新聞」答沒有→查證 Google 新聞近 2 天 100 則，屬未收錄→新增主題新聞搜尋＋國際新聞池（派 Sonnet）。
- **評等紀錄檢查** 2026-10-06 09:00：自上次 17 筆，無值得檢討案例、尚無滿 1 日結果；發現盤前今日建議名單 07:51／08:05／08:35 三次都換股（輸入理應不變）→派 Sonnet 查根因。
- **評等紀錄檢查**（scripts/check-rating-log.py）：2026-10-05 首次，11 筆（今日建議 8 檔全等回檔、技術篩選 2 檔等回檔、2330 先不要買），尚無滿 1 日的結果。
- 2026-10-05 10:08～11:51（台北，盤中）使用者 8 筆，查證屬實，處理：①「這幾檔有你特別看好的嗎」指代錯成台積電→intent 指代改解析上一則清單全部股票；②想找「現在走勢像和益一個月前」的股→新功能「走勢相似度搜尋」（列待辦，等一致性改版後做）；③④健鼎名單說建議買、個股頁說觀望／每次答案不同→建立程式算的唯一「本站綜合評等」，今日建議／AI問答／個股按鈕共用、AI 只解釋不推翻、降 temperature；⑤13:30～14:30 以盤後定價立場、14:30 後以明日開盤立場回答；⑥14:30 後今日建議改「明日開盤建議」且內容對應。③～⑥派 Opus 處理中。
- 2026-10-04 22:25～22:39（台北，週日休市）使用者 7 筆，全部查證屬實，2026-10-05 派 agent 修：①「快黃金交叉」本站無此掃描→新增即將交叉清單；②③台光電／旺矽買進區間與停損矛盾、未持有卻叫停損、區間上緣等於收盤未解釋→改個股分析規則；④全市場推薦只列數據沒講為什麼買→改規則；⑤問 2330 卻扯進台灣精材（symbolResolve 只解析到 2330，屬模型扯入新聞裡的公司）→加規則；⑥問完 2330 再問「建議買嗎?」被判成全市場推薦（已重現：wantsMarketWideBuyIdea 太寬）→改 intent.ts；⑦🛠 台股個股頁「市值／EPS較市場預期／下次公布財報日期」全暫缺（這三項只有美股來源）→補台股市值、法定財報期限，台股不顯示市場預期。
- 2026-10-04 22:05（台北）🛠「券資比就是融券嗎？為什麼用券資比」：屬於提問、非錯誤，已在對話中解釋；使用者之後決定把「券資比」改成跟融資使用率對應的「融券使用率」（融券餘額÷融券限額），改版中。同時段另一筆為驗證 agent 測試，略過。
- 2026-10-04 21:50～21:55（台北）3 筆皆為驗證 agent／我自己的測試回報（「驗證用測試回報，請忽略」與一筆👍），略過。使用者表示有送回報但資料庫沒有→查出原本送出失敗也顯示「已收到」，已改成失敗會提示並保留內容。
- 2026-10-04 21:42（台北，週日休市）📝回報「明天可以買華航嗎」：使用者指出油價已經下跌、AI 沒跟上。查證屬實：本站油價只有 FRED（約每週更新、落後一週），且個股資料沒有產業外部因子。已修：新增近即時油價（Yahoo WTI／Brent 期貨）與「產業關鍵外部因子」區塊＋規則（`a6fc681`）。
- **上市個股「三大法人」常顯示資料暫缺、AI 只拿得到全市場法人合計**：T86 含權證版約 2.4MB、下載約 7 秒，撞 8 秒逾時變空表且被快取 1 小時；改抓不含權證版（約 190KB）。→ 工作日誌 2026-10-05（續），搜尋「T86」。
- **AI 給的買進區間與出場價互相矛盾、說「已在區間內」實際不在**：模型自編價位不守規則；改由程式先算支撐壓力與自洽框架（`grounding/priceLevels.ts`）。→ 工作日誌 2026-10-05（續），搜尋「priceLevels」。
- **本站推薦的股票買了就跌、勝率低**：舊技術面評分把 RSI 超買只「不加分」不扣分，急漲股照樣湊滿支持；回測 5日超額為負（跑贏率約 30～36%），追高是主因。→ 工作日誌 2026-10-05（檢討），搜尋「負向選股」。
- **AI 問答說「沒有某公司的資料」但個股頁查得到**：台股官方簡稱帶「*」或「-KY」（國巨*、臻鼎-KY），名稱比對沒有去掉標記。→ 工作日誌 2026-10-05（續4），搜尋「國巨」。
- **Gemini 回答被截斷、或突然都變成 NVIDIA 回答、或回 429**：免費層非 lite 模型每模型每天只有 20 次、3.x 非 lite 是思考模型（思考 token 吃 maxOutputTokens），2.5-flash 對新金鑰 404；問答主力用 flash-lite，思考模型要加 thinkingConfig 與思考預算並做每日配額。→ 工作日誌 2026-10-05（續7），搜尋「Gemini 分級」。
- **首頁卡片一直標示「Gemini Flash Lite；較強模型今日額度用完」**：本機 agent 測試與正式站共用同一把金鑰，吃掉非 lite 每日 20 次配額；且思考模型時限太短逾時。本機已強制只用 lite（premiumAllowedHere）。→ 工作日誌 2026-10-06（續3），搜尋「premiumAllowedHere」。
- **今日建議名單在資料沒變時（盤前／深夜）反覆換股**：上游失敗被吞成空清單且殘缺結果照常快取。凍結時段保留上一份名單（actionStability.ts）。→ 工作日誌 2026-10-06（續3），搜尋「盤前名單跳動」。
- **正式站 AI 問答用股名問卻答成大盤、resolvedTargets 為空**：先檢查是不是測試端編碼——Git Bash 的 curl 送中文 JSON 會變亂碼，改用 Python urllib（UTF-8）送。→ 工作日誌 2026-10-06（續3），搜尋「誤報」。
- **刪 git worktree 資料夾時把主 repo 的 node_modules 一起刪掉**：worktree 裡的 node_modules 是指向主 repo 的 junction，`rm -rf`／`Remove-Item -Recurse` 會刪到目標內容；先 `cmd /c rmdir <worktree>
ode_modules`（只刪連結）再刪資料夾。→ 2026-10-06 刪 Stock-web-baseline。
- **盤中畫面報價落後 30 秒～2 分鐘**：TTL＜輪詢間隔＋SWR 只等 1.5 秒回舊值、MIS 同網址回上游快取。→ 工作日誌 2026-10-06（續3），搜尋「x-live-poll」。

## 品保流程（詳細規則見 CLAUDE.md，這裡只摘要）

使用者要求每次對話回報「更新完成」前要走完：
1. **規則一**：同一類問題卡關連續失敗 2 次，第 3 次要同步派 2 個不同模型 agent 上網查解法，交疊進行不間斷。
2. **規則二**：自己先做一次完整的實測（build+start+curl，模擬瀏覽器操作）地毯式檢查，抓到的問題全部修好；之後只要針對這次修的問題複查即可，不必每次重新全站掃。
3. **規則三**：規則二做完後，派 1 個 Opus agent（額度不夠才臨時換模型頂替，之後仍改回 Opus）做一次完整地毯式檢查；抓到的問題自己修，修不好就讓 Opus 直接動手；之後只需針對這次修的問題再複查，直到 Opus 確認「沒有發現問題」才能回報「更新完成」。
4. **規則四**：每次回覆使用者都要附上網站網址 https://stock-web-blond.vercel.app 。**網址跟密碼絕對不能寫在同一行/緊接在一起**（會被通訊軟體自動連結辨識吞掉變成壞連結，這件事已經真實發生過不只一次），務必分開兩行。
5. **規則五（跨裝置接續）**：每次回覆使用者之前，都要更新這份 PROGRESS.md 並 push，讓其他裝置的 Claude Code 接得上。
6. **規則六**：只要在等待背景工作完成（部署、下載、agent 執行等）導致一段時間沒有新回應，每最多 5 分鐘要在對話視窗主動回報一次目前狀態，不能整段沉默、也不能只依賴「完成才通知」的機制悶著頭等。

## 工作日誌（新到舊，只列有意義的變更；commit hash 對應 `git log`）

### 2026-10-06（續3）：較強模型常退回 Lite 修正＋中斷任務接續

- 使用者回報首頁卡片一直標示「Gemini Flash Lite；較強模型今日額度用完」。根因：本機與正式站共用同一把 Gemini 金鑰，agent 本機測試吃掉非 lite 每模型每天 20 次配額；今日建議 AI 時限 25 秒、思考模型只分到約 16 秒常逾時。修法（`4d0d4ed`）：premiumAllowedHere()——非 lite 只在 Vercel 用（GEMINI_PREMIUM_LOCAL=true 才本機開）；今日建議 40 秒、快報 38 秒。tsc／332 測試過；正式站要等下一個重寫時點觀察。
- 盤中報價即時性（`c701bb6`、`243a869`、`850c719`）：根因＝快取 TTL 25 秒＜輪詢 30 秒，每輪都拿到過期值、只等 1.5 秒就回上一輪舊值（實測單檔最舊 137 秒）；MIS 同網址會回上游快取。修法：前端輪詢帶 x-live-poll，伺服器同步等重抓 6 秒；關注清單上市只抓清單內那幾檔；MIS 加防快取參數；Quote 新增上游成交時間 tradeTime 並顯示。全站自動刷新（同頁不動也更新）交同一 agent 追加中。
- 「鴻海能買嗎」答成大盤：**誤報**——是我在 Git Bash 用 curl 送中文 JSON 被轉碼成亂碼，伺服器收到的問句沒有股名；改用 Python UTF-8 送就正常。順帶在 AskResult 加 resolvedTargets 診斷欄位（`63c5d40`）。
- 跨入口一致性抽測（正式站）：同一檔在關注分析、個股按鈕、直接提問的結論逐字相同（鴻海、聯發科建議買進；陽明減碼或出場）。陽明「減碼或出場（獲利已吐回）」虧損仍寫獲利吐回＝評等穩定化 agent 的 B 項修正中。
- 使用者再問 AI 模擬投資組合（100 萬、首頁顯示成效）→派 Opus 實作（程式依本站評等決策、Redis 紀錄、對照 0050、首頁卡＋/portfolio、交易結果納入學習循環）。
- 今日建議盤前名單跳動（`f9981ca`）：根因（由紀錄推得、無法盤前重現）是上游抓取失敗被 .catch 吞成空清單、殘缺結果照常快取 10 分鐘，加上同分排序依來源順序。修法 actionStability.ts：凍結時段（平日 22:00～08:30、週末）上一份名單只有被明確降級為先不要買才換、抓不到視為未知保留；輸入不完整只快取 60 秒；同分以代號定序；action-list:v2。15 項新測試、357 全過、正式站 200。待辦：明早 07:50～08:30 看 log「[action-list] 輸入不完整」確認是哪個上游。
- 使用者提供「本機專用」Gemini 金鑰（另一個專案、額度獨立），已換進 .env.local 並實測可用；正式站 Vercel 維持原金鑰。之後本機測試不再吃正式站額度（premiumAllowedHere 仍保留，本機要測非 lite 需 GEMINI_PREMIUM_LOCAL=true）。
- 正式站獨立驗證（Sonnet，09:00）：二分評等、主題新聞、錯字近似、模型標示、表格 UI（四欄收合同步、凍結表頭／名稱欄、手機方向鎖定、產業欄）皆通過；/action 頁首仍寫三級制→已改（`a1a5c0d`）。09:00 今日建議由 Gemini 3.6 Flash 撰寫（修正後不再退回 Lite）。未驗：評等變動說明（沒碰到變動個股）、明日操作卡（盤後才有）。
- 整合稽核與表格 UI agent 撞 session 額度中斷，但工作已提交（`18079d8` 表格、`35e3fe3` 評測一致性、`4fe9bb0` 架構文件由我補提交）；正式站驗證併入新派的獨立 Sonnet 驗證 agent；另派 Opus 做「Lite 下限＋評測 bug 9 項」。

### 2026-10-06（續2）：主題新聞搜尋＋國際新聞池＋整合稽核

- 主題新聞（`7e06386`）：根因是 AI 問答只餵台股／美股市場新聞池，沒有依問句主題搜尋，所以「美國 伊朗」答成資料裡沒有。新增 topicNews.ts（Google 新聞 RSS 近3天8則、15分鐘快取、失敗與0則分開標示）、intent.extractTopicNewsQuery、RULE_TOPIC_NEWS、BLOCK_MARKERS.topicNews；市場新聞池與快報補國際／地緣政治／Fed 查詢。正式站 curl 3 題通過（美伊、Fed、台積電仍走個股流程）；Lite 偶有標題混述，待跨模型評測。同 commit 含 ratingChange 接線（RULE_RATING_CHANGE），正式站驗證待獨立驗證 agent。
- 整合稽核（進行中）：`8c2ced0` ratingCore 正式站與回測共用（3,777 組逐值相同）、`b9ca0ec`、`38311a1`、`cd91895`、`a822292` 跨入口整合測試 15 項（全套 331 過）。

### 2026-10-06（續）：評等果斷化整批完成

- 二分評等（`0e01390`，stock-rating v4、action-brief v13、ratingConsistencyGuard 擋先不要買的區間／出場價、弱市況提示、今日建議最多5檔）；Gemini 分級與時點重寫（`343b247`、`64e6383`、`2322d34`，問答 lite、今日建議／快報／AI 判斷非 lite＋思考預算、每模型每天18次配額）；今日建議兩層（`f4f4d9f`，名單價位即時跟 stockRating、AI 解說依時點、不跨日）；篩選誤判（`fdce118`）；錯字近似（`055bf70`，fuzzyName.ts）；教訓依擴大回測更新（`52255ee`）；AI 判斷層不顯示（`28a6750`，AI_VIEW_VISIBLE_TO_USERS=false）；評等變動說明 ratingChange.ts（`70035aa`、`e3460bd`，接線待主題新聞 agent 一併提交）。正式站 curl 4 題通過；今日建議由 Gemini 3.6 Flash 撰寫。

### 2026-10-06：跨模型評測框架與第一份基準

- scripts/eval（`4beccdb`…`50806d7`）：題庫 33 題（含使用者真實回報）、程式評分器、三家同輸入執行器（forceProvider、假時鐘、--judge、--regrade、--compare），報告 docs/eval/（先看 2026-10-06-baseline-analysis.md）。改前 722a9c6→改後 0e01390：Lite 97%→96%、NVIDIA 94%→95%（持平，二分化沒讓模型變差）；Groq 免費 TPM 8000 接不住個股題（約1萬token）。Lite 守規則最高但深度不足（評審 3.1 vs NVIDIA 4.3）。
- 評測抓到的 bug（待「提高 Lite 下限」agent 處理）：9999 不存在被說「有涵蓋暫時連不上」（notFoundNote 無條件夾帶）；「建鼎呢」帶對話紀錄時錯字比對被 movers 判斷跳過；名稱標記外洩「國巨*」；盤後定價立場行與二分評等矛盾；RULE_NO_UNVERIFIABLE_CONFESSION 不該只要有對話紀錄就組入；比較題規則範例被照抄。Stock-web-before worktree 已移除。

### 2026-10-05（續7）：今日快報因果版＋存檔、手機固定表頭、Gemini 分級

- 今日快報（`b04cdc8`…`987978b`）：今日重點／台股美股「現象→原因→後續」／明天要留意，約650～900字；BRIEF_RULE_CAUSE_GROUNDING 原因須有出處否則寫原因不明；briefArchive.ts 每日存檔（Redis brief-archive:v1，一天最多2次、17:00後覆蓋定稿、含參考資料與模型、保留400天）＋ /api/brief-archive。正式站 Gemini 3 Flash 產生 903 字範例。限制：Nemotron 備援會編原因。
- 手機固定表頭（`a24ef31`）：<1280px 表格容器雙向捲動、sticky 表頭＋名稱欄、拖曳到邊緣自動捲動；iPhone／Android／平板模擬通過，未在真 iOS Safari 測。
- Gemini 分級（`64e6383`）：問答 flash-lite；今日建議／AI 判斷層走非 lite 思考模型（每模型每天18次配額、輪替、thinkingLevel low＋4096思考預算、404下架排除），實測：2.5-flash 對新用戶 404、3.8-flash 免費每天20次、思考模型需加思考預算否則截斷。

### 2026-10-05（續6）：學習循環第二階段＋模型標示＋市況研究結論

- 第二階段與結構修正（`4b695fe`、`8509afe`、`006c420`、`94d7fa1`、`b19f417`）：numberGuard.ts 回答後價位檢查（小數點位移／差>30% 自動更正）；actionPicks.ts 今日建議名單程式決定（每組≤3、去重、互斥），AI 只回 JSON 解說；aiJudge.ts AI 判斷層（每檔每天一次、寫評等紀錄 ai 欄位、`AI_ADJUST_AFFECTS_CONCLUSION=false`）；championChallenger.ts 冠軍／挑戰者＋放寬判準（≥60筆、AI實際調整≥20筆、平均獎勵高≥0.3pp、配對t≥2）；教訓＋證據不可分割；每則回答標示模型、回饋與判斷層記 model、/scoreboard 各模型區塊。發現正式站 Gemini 實際用 gemini-flash-lite-latest（交果斷化 agent 修偏好）。
- 研究 C（`82c78bd`、docs/backtest/2026-10-regime.md）：2022～2024 樣本外，弱市況硬開關未達可靠標準、V 型反彈會錯過→**不上線硬開關**；技術支持組在弱市況可靠為負（20日 −0.98%，t −3.92）→改加「弱市況提示」不改結論（交果斷化 agent）。

### 2026-10-05（續5）：AI 學習循環第一階段上線＋A/B/D＋持股修正

- **學習循環第一階段**（`50d1293`→`02cd8e1`）：評等紀錄加 `feat`（原始特徵）與 `rg`（市況，learning/regime.ts）、預留 `ai` 欄位；learning/reward.ts（成本0.585%、回撤懲罰0.5、不買卻大漲3%）；每日學習工作接 warm-cache 收盤後一次（`/api/cron/learning?force=1` 可手動）；learning/weights.ts（收縮、半衰期60日、≥30筆、分市況，改用「相對同市況平均」獎勵；`LEARNED_WEIGHTS_ENABLED=false`，擴大資料前學後驗未通過）；learning/similar.ts 相似案例（<10筆標樣本不足）＋ RULE_EXPERIENCE（在 learning/experienceRule.ts）；lessons.ts 6 條教訓＋ scripts/update-lessons.py；/scoreboard 看板、/api/learning。第一批 1 日成績最早 10/6 收盤後。已知：AI 引用教訓時有時沒帶證據數字。
- **持股修正＋A/B/D**（`23a3e1b`、`016283c`）：持有中停損改近端支撐（≤8%、高於跌停）、持股問題一律用含成本評等（「賣掉哪些」與分析一致）、清單全部檔都有評等、判斷題 3～5 個帶數字理由、AI 表達看法與把握；A 技術不支持一票否決、B 急漲改短線波動風險提示、D 不暗示勝過大盤並提 0050。wide 回測改前後差異在雜訊內。正式站驗證通過；「先不要買仍提區間」已修；「明日操作建議」上線（`1432844`、`cc35079`、`e67d9d3`：14:30 後標題「明日操作建議」、等回檔寫「盤中回到 A～B 可分批買」＋掛單價＋出場價，快取 v10，假時鐘測試＋正式站 18:35 驗證）。殘留（交下一個 agent 結構性修）：AI 抄錯停損價一位數、等回檔名單超過每組 3 檔、同檔同時在「不建議追」與等回檔。學習循環第二階段（AI 判斷層＋冠軍／挑戰者）同一個 agent 接著做。

### 2026-10-05（續4）：擴大回測結論＋下午回報修正

- **擴大回測**（`730f831`、`1dea6c7`，報告 docs/backtest/2026-10-wide-summary.md）：198 檔×99 週（2024-10～2026-08）、同市值層級中性化、Newey-West＋區塊 bootstrap。結論：沒有任何買進邏輯扣 0.4% 成本後穩健勝出；唯一穩健訊號是「技術面不支持」可靠落後（10日 −0.37%／20日 −0.65%）；本站「建議買進」+0.23%（不顯著，扣成本後約 −0.2%）；追高組 20 日 +1.64%（t=1.90，上漲市況可靠為正）→ 60 檔小樣本「追高最差」沒有重現。建議：技術不支持改一票否決、追高防護可放寬或改為短線波動風險、研究大盤市況開關（需 2022～2024 樣本外驗證）、措辭不暗示超額報酬。使用者 10/5 決定照我的看法執行：A 技術不支持一票否決（採用）、B 追高防護改為短線波動風險提示（不再自動等回檔）、D 措辭不暗示勝過大盤並提 0050 對照——交給持股修正 agent 一併做；C 大盤市況開關先研究（另派 agent，延伸 2022～2024 樣本外驗證，只動 scripts/backtest 與 docs）。
- **下午回報**（14:10～16:58，7 筆屬實）：國巨解析不到（官方名「國巨*」）→ `58caa3d` 修好；持股停損價離譜（友達 39.05 停損 32.65 低於跌停）、同清單 3 分鐘內「建議賣」與「沒有要賣」矛盾、清單後段無評等、判斷題太淺、AI 太保守不敢表達 → 派 Opus 修中。

### 2026-10-05（續3）：評等紀錄上線、追高防護、CSV 匯入匯出、AI 學習循環開工

- `7ba6cfd`、`30fb3fc`：chaseGuards.ts（只啟用回測有效的急漲規則）、建議買進與等回檔分組（等回檔明寫「現價不買，等回到 A～B」）、持有停利提示（曾獲利≥8%跌回成本→減碼或出場）、ratingLog.ts（每日每檔每結論記第一次、after() 寫入、保留400天）；「今天有什麼股票推薦買進」改判全市場推薦。正式站驗證通過。回測：等回檔組回到區間才買抱 5 日平均 +0.71%（未扣大盤）。
- `2148989`：關注清單匯入 CSV（預覽、取代／合併、自動備份＋復原）；匯出改 UTF-16LE＋BOM＋Tab（修舊版 Excel 亂碼與欄位錯位）。正式站兩個瀏覽器往返驗證清單／順序／持股完全相同。發現專案已有 Google 登入同步關注清單的程式（auth.ts、WatchlistSync），但 Vercel 沒設 AUTH_GOOGLE_ID／SECRET 所以未啟用。
- AI 學習循環第一階段派 Opus：判斷依據狀態＋市況入紀錄、獎勵計算、依據權重（6 項保險、先展示不改結論）、相似案例統計、教訓清單（lessons.ts）、/scoreboard 成績看板。擴大回測（2年200檔）背景進行中。

### 2026-10-05（續2）：檢討規則上線＋替代邏輯回測無穩健優勢＋使用者決定

- `7d797b3`：回測工具進 repo（scripts/backtest）、追高防護只採用回測有效的「急漲改等回檔」（RSI 封頂在推薦組 0 筆觸發、乖離／外資大賣無鑑別力不採用）、建議買進與等回檔分組、持有停利提示、評等紀錄（推薦與不推薦都存）＋ /api/rating-log ＋ scripts/check-rating-log.py。
- `e88099e`：5 種替代選股邏輯（多頭回檔、相對強勢未過熱、法人連買、營收高成長、拆解不要買組）在 60 檔／2 個月樣本都沒有穩健正超額；不要買組 +0.35% 主要來自 5 檔。
- 使用者決定（10/5）：①擴大回測（約 2 年、200 檔含中小型、分市況）—派 Opus 中；②「尚未驗證」標示**不做**；③風險控管（急漲等回檔、停利提示）維持；④評等紀錄＋獎勵機制照計畫繼續（等評等紀錄正式站驗證完成後開工）。
- 關注清單匯入 CSV＋匯出改 UTF-16LE Tab（修舊版 Excel 亂碼、欄位錯位）：`2148989`，正式站往返驗證中。

### 2026-10-05（檢討）：8 檔推薦虧損事後檢討——舊技術評分是負向選股

- 使用者依推薦買的 2603、6811、2609、1528、2454、2449、6683、2351 多數虧損，同期加權 +9%。推估買進日 9/16、9/22。6 檔是追在急漲／漲停後（5日+16～24%、距MA20 +17～24%、RSI 70～77），2603／2609／6811 屬正常波動或族群輪動；多檔曾獲利 5～12% 但沒有停利提示。
- 回測（前60大上市股、8/3～9/22、960 筆、隔日開盤進場、對同日平均的超額）：舊「技術支持＋籌碼不反對」5日超額 −1.06%、跑贏率 36%；siteRating「建議買進」−1.47%、30%；RSI≥75 −2.58%（最一致）；5日漲>15% −1.75%。過濾規則只能避開最差群。
- 後續：派 Opus 把回測工具放進 repo、逐條回測後才採用的規則（RSI 封頂、急漲／乖離過大改等回檔、外資大賣籌碼不支持）、等回檔與建議買進分組顯示、持有中停利提示、評等紀錄（推薦與不推薦都存）＋ check-rating-log.py。腳本原檔暫存 scratchpad/postmortem/。
- 另修：多檔比較第一句必須選出一檔（`8d66f6d`，使用者回報「台光電與健鼎比較推薦哪檔」沒回答到）。

### 2026-10-05（下午）：本站綜合評等（三入口一致）＋時段立場＋版面

- **本站綜合評等**（`4effb76`…`43ad53f`）：`siteRating.ts` 純程式算結論（五面向門檻＋priceLevels＋漲多警訊→建議買進／等回檔（附區間）／先不要買；持有中另算），`stockRating.ts` 唯一入口、快取10分鐘（代號＋台北日期）；今日建議、全市場推薦、技術篩選、個股問答都讀同一份，規則 `RULE_FOLLOW_SITE_RATING` 要求第一句照抄不可推翻；AI temperature 統一 0.2。正式站：同題連問兩次結論區間相同，今日建議名單股拿去個股問答結論一致。
- **指代與時段**：「這幾檔／這些／名單裡」解析成上一則清單全部股票（上限8）；`tradingStance.ts`：13:30～14:30 盤後定價立場、14:30 後明日開盤立場（週五盤後／週末＝下個交易日）；今日建議 14:30 後改「明日開盤建議」且內容與快取 key 依時段區分（`action-brief:v7:{日期}:{today|next-open}`）。假時鐘測試覆蓋；13:30 後實測盤後定價立場通過，14:30 後未實測。
- **版面**：關注清單桌機≥1280px 免水平捲動＋sticky 表頭（`24136be`、`4810879`，1280～1920 實測）；/search 盤中30秒輪詢（`03fcae7`，實測每30秒、200列與捲動位置保留）；欄位順序 成交量→股價→漲跌幅 移到最右（關注清單放在持有股數左邊，`c05bc8e`，驗證中）。
- **待決定**：大漲日今日建議 8 檔全是「等回檔」，若使用者覺得太保守可調 `NEAR_ZONE_PCT`（目前1%）或漲多警訊判定；8 檔虧損檢討報告完成後一併評估規則。

### 2026-10-05（續）：盤中複查問題修正＋/search 分頁加速＋agent 主動回報

- **盤中複查 5 項修正**（`96835fb`…`90e3ce8`）：價位改由程式算支撐／壓力與自洽框架（`grounding/priceLevels.ts`，AI 只能照用）；個股法人 T86 改抓不含權證版（2.4MB→190KB，原本常 8 秒逾時變空表並快取 1 小時，個股頁法人也常「資料暫缺」，key 升 `chips:TW:institutional:v2`）、過濾多檔彙整新聞標題；/highlights 三個榜改 LiveMoversBoard 每 30 秒輪詢；法定財報期限遇週末順延；快報同數字只寫一次。正式站重問旺矽、台積電法人、/highlights 輪詢、11/16 皆驗證通過。
- **/search 加速**（`90fa6a3`）：API 加 offset／total／排序快照 id／withChips，前端先載 100 檔＋顯示更多／捲動自動載入，籌碼隨列表回傳；前10列含籌碼 3.5～8.7 秒→1.1～2.2 秒；5 種排序分頁串接與全量逐筆相同。搜尋快照用行程記憶體（不用 Redis，避免逐字輸入耗 Upstash 額度）。盤中 30 秒輪詢補做中。
- **其他**：SiteHeader set-state-in-effect lint 修正（`8917225`）；CLAUDE.md 新增「派出的 agent 每 10 分鐘 SendMessage 回報給 main」（已實測可行）與「驗證 agent 限時」。關注清單桌機免水平捲動＋固定表頭：派 agent 中。

### 2026-10-05：依使用者回報修 7 項＋融券使用率＋即將交叉＋台股市值財報日（Sonnet 盤中正式站複查：報價／30秒輪詢／當日K線／興櫃／融券使用率／財報卡／快報建議盤中措辭／回饋／載入皆通過；旺矽價位仍不自洽、台積電個股法人缺且夾無關股、/highlights 未輪詢、11/14 未順延、快報贅句——修正中）

- **融券**：籌碼第四項先做「券資比」（`d0ff2de`），使用者看不懂改成跟融資對應的「融券使用率」＝融券餘額÷融券限額（`c85b10d`，TWSE 次一營業日限額／TPEx ShortSaleQuota；6488 0.54%、1301 0.08% 與官方手算一致）。
- **AI 問答回報修正**（`b9bc7a3`、`3fd7fa9`、`bd79580`）：「建議買嗎?」這類是非追問改接上文個股（wantsMarketWideBuyIdea 需有列清單字眼）；個股題不附一般新聞標題、只談被問的股；價位自洽（未持有不說停損、出場價低於買進區間、說明現價與不追價）；全市場推薦每檔先講理由、全過熱時第一句說等回檔。正式站重問 3 題通過。
- **即將黃金／死亡交叉掃描**（`b41c024`…`7bc3609`，`lib/nearCross.ts`）：KD 差距≤5 且連續縮小、MACD 柱狀體收斂，門檻具名常數；正式站問「快要KD黃金交叉」有清單。
- **台股市值與財報日**（`e59e6ea`）：市值＝現價×官方股數（t187ap03 上市／上櫃／興櫃）；下次財報顯示法定最晚期限（一般／金融／金控三組）；台股「EPS較市場預期」改說明文字。
- 其他：AI 個股新增油價「產業關鍵外部因子」（`a6fc681`、`5c922a2`）；🛠回報網站（`caeab51`）；回饋送出失敗會提示（`debf64c`）；週末不說今天、數字照抄、全繁中（`2b06be7`）。測試共 117 項。

### 2026-10-04：AI 問答上下文／精簡／歷史脈絡、今日快報與建議精簡＋籌碼面向、全站30秒輪詢與SWR、零花費稽核（多 agent 平行，Opus 正式站複查後修正）

- **AI 問答**：個股資料附近5日逐日 MACD/KD 交叉紀錄；新增不跳題、不承認無法驗證的先前說法、是非題第一句直答、歷史脈絡綜合判斷、精簡（約200字）等規則；關注清單只在談持股時附逐檔損益；短追問接回上文（`cbf7ec6`、`a77e677`、`75b80d4`）。個股【歷史脈絡】（區間報酬、52週位置、法人／融資／外資多日趨勢、營收與EPS多期、指定期間逐日＋程式算好的合計）與大盤【市場歷史與情緒走勢】（指數、VIX百分位、法人／融資連續天數）由 agent 完成（`db415cb`…`8216d09`）。
- **今日快報／今日建議**：體檢表新增「持股結構面（大戶／外資／融資）」第5面向（`459b869`、`9332ace`）；輸出精簡到快報≤500字、建議≤400字，快取 30→10 分鐘＋過期先回舊資料（`1784580`、`d7fafbd`、`a315405`）。搜尋頁排序新增大戶／外資／融資（`49c785b`）。
- **效能**：盤中輪詢台美統一30秒、即時快取 TTL 25 秒（`7067368`）；cache.ts 新增 stale-while-revalidate（after() 背景重算、single-flight），首頁冷啟動 20 秒→3.4 秒、/news 10 秒→2.9 秒；背景分頁暫停輪詢；warm-cache 回應期限 25 秒（配合 cron-job.org）。
- **零花費稽核**：Vercel Hobby／Upstash Free／GitHub Free／Gemini Free／Finnhub Free 皆無付款方式；發現 Vercel 上殘留 ANTHROPIC_API_KEY（按量計費）→ 程式加 `ALLOW_PAID_AI` 閘門（`3849a0e`），使用者已刪除該變數。CLAUDE.md 新增零花費原則、多 agent git 規矩、規則二改「大改動派獨立驗證 agent（預設 Sonnet）、小修正自己驗」、規則五改每10分鐘。
- **Opus 正式站複查抓到並已修**（`cdef8b9`）：EPS 標籤仍是舊的（快取鍵升 v3）、週末問「上週」抓成前前週且 AI 自行加總算錯（改指剛結束交易週＋程式算好期間合計）、快報寫「收跌0.48萬點」與「合計賣超卻連買」（數字規則＋措辭改「最近已轉為連買」）、今日建議頁首門檻說明與實際規則不符。週末台股報價異常（休市日顯示漲停價、委買賣中價）與首頁關注表格約6秒：修正中。
- **PROGRESS 整理**：已知問題只留未結案項目、9/22～9/23 工作日誌與 9/11 環境紀錄搬到 PROGRESS-ARCHIVE.md（主檔 1,087→約 570 行）。

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

## 目前已知問題

- **【待辦，2026-10-04 使用者要求先記錄】融資／融券「組合判讀」訊號**：三個 AI 功能（問答、今日建議、今日快報）都拿得到融資／融券張數與券資比，但沒有「股價漲跌 × 融資增減 × 融券增減」的明確判讀（例：漲＋融資大增＝追高風險；漲＋融券增＝可能軋空；跌＋融資大減＝賣壓出清；跌＋融券增＝空方佔優）。做法：程式先算好每檔訊號（門檻具名常數，例如融資單日增減>3%算大增）→ 三個 AI 功能都附上並規定要講出來 → 今日建議持股結構面納入計分（漲＋融資暴增扣分等）→ 補測試。仿照 2026-10-04 油價「產業關鍵外部因子」先算結論的做法（模型只給數字會漏判）。
- **【進行中／待辦，2026-10-05 使用者要求】推薦失敗檢討與長期學習機制**：使用者依本站推薦買進 2603、6811、2609、1528、2454、2449、6683、2351，多數虧損（-1.8%～-11.6%）。①檢討：派 Opus 用歷史日K／籌碼重建買進日狀態、歸納失敗模式、提出可程式化的評分規則修改並回測（分析中，不改程式）；②待辦（等「本站綜合評等」改版完成後）：建立評等紀錄——**推薦與不推薦都存**（使用者 2026-10-05 確認；不推薦也存才算得出「說不買卻大漲」的錯失），每筆：台北時間＋時段、代號名稱、當時價格與價位框架、結論、五面向評分與理由、來源入口；同一檔每交易日只記第一次＋盤中評等變動時再記一筆（不因每30秒刷新或重複提問灌資料），存 Redis（估一年約10MB）＋自動追蹤推薦後 1／5／20 日報酬與勝率，定期回饋調整評分門檻。缺口：本站原本沒保存任何推薦紀錄（今日建議只快取10分鐘）。
- **【第二階段 10/5 已推送（`4b695fe`、`8509afe`），模型標示 `006c420`，正式站驗證中；本機已加 GEMINI_API_KEY（.env.local，未提交）；跨模型評測框架 scripts/eval 建置中】AI 經驗累積三層架構**：使用者希望 AI 繼續參與判斷，並隨經驗（回報、推薦／不推薦紀錄、多方資料）越來越準。設計：①程式基準＝siteRating（一致性）；②AI 判斷層＝讀程式評等後可依新聞／法說／大盤情緒／過去經驗上調或下調「最多一級」並寫明理由，兩個結論都記錄；③經驗層＝(a) 相似案例統計：從評等紀錄找條件相似的過去案例算 5 日上漲比例與平均報酬給 AI 參考，(b) 教訓清單（由回報與事後檢討歸納、每次檢查時更新，AI 判斷時帶入相關條目），(c) 冠軍／挑戰者：定期比較「程式評等」與「AI 調整後」的實際勝率，用結果決定 AI 調整空間；所有規則調整先用累積紀錄回測。誠實限制：免費 AI 無法重新訓練模型，「學習」＝記憶＋統計＋校準；需約 1～3 個月累積才有統計意義。**獎勵機制（使用者 2026-10-05 提議並採用）**：每筆評等滿 5／20 日算獎勵＝對大盤超額報酬－最大回撤懲罰（不推薦卻大漲＝扣分）；獎勵分配給每個判斷依據（RSI過熱、法人連買、站上均線、油價因子、AI調升一級…）累積分數並自動調整其在綜合評等的權重；保險：每依據至少約30筆才調、貝氏收縮從中性起步、近期加權（舊資料衰減）、多頭／空頭／盤整分開統計、調整前用未用過的資料回測、做成績看板頁面公開各依據勝率／獎勵／權重。**整合方式（使用者 2026-10-05 確認、6 項保險全加）**：循環＝判斷（程式評等用目前權重→AI ±1級並參考相似案例與教訓）→記錄（兩個結論＋當時所有判斷依據狀態）→滿5／20日算獎勵→(1) 依據權重更新、(2) AI 調整本身也是一個依據、用累積獎勵決定 AI 可調幅度（冠軍／挑戰者）、(3) 相似案例庫＝評等紀錄本身（顯示樣本數）、(4) 教訓清單每條附統計證據、證據不成立就修正或刪、(5) 新資料產生新依據、從中性權重起步。實作順序：評等紀錄（進行中）→相似案例＋教訓清單＋依據權重→AI 判斷層＋冠軍挑戰者＋成績看板。
- **【待辦，2026-10-05 使用者要求，等基準評測＋果斷化完成後開工】提高 Flash Lite 的下限**：AI 問答主力是 Gemini 3.5 Flash Lite（思考少；非 lite 免費每模型每天僅 20 次、思考模型會吃 maxOutputTokens 被截斷）。做法：①程式產生每檔「決策摘要卡」（結論＋依重要性排序的前3理由帶數字＋風險＋操作計畫），AI 只解說與補程式算不到的（新聞意義、產業脈絡）；②依題型精簡資料、要點放最前；③答題骨架（結論→理由→風險→做法）；④從使用者👍的回答挑各題型範例當 few-shot；⑤回答後檢查（價位、結論一致、禁止字、長度）失敗就帶錯誤訊息重生一次；⑥評測以「最差幾題／各模型最常失敗規則」衡量下限，改前改後比較。
- **【待辦，2026-10-06 使用者要求，等評測 agent 跑完後開工】四入口品質比較與一起進步**：今日建議卡、關注清單分析、個股頁「問AI關於」、直接提問，結論與價位已確認來自同一份評等（正式站抽測聯茂、鴻海、聯發科、陽明逐字相同），差別在 AI 解說品質（今日建議用較強模型、其餘用 Lite）。做法：scripts/eval 新增四種題型、同一批股票同時跑，評審分數＋規則通過率比較，找出最優格式／資料組合，把它的骨架、結論卡、資料區塊套用到其他入口，改後再比；評等紀錄依 source 分入口追蹤 5／20 日結果。
- **【待辦，2026-10-05 使用者提出】伺服器端對話記憶**：讓 AI 記得所有裝置的過往對話（使用者：「每次都說看不到，這樣也不能精進」）。構想：對話紀錄存 Redis（全站共用、密碼閘內、保留30天、上限N則），AI 回答時依提到的股票取回「本站過去對它說過什麼＋當時評等」（評等紀錄已有）；注意零花費與 Redis 指令數。
- **【待辦，2026-10-05 使用者提出】AI 模擬投資組合**：仿關注清單的頁面，AI 以 100 萬虛擬資金在盤中／盤後依評等與判斷自行買賣、記錄理由、計算績效對比 0050，並把成敗納入學習循環（獎勵）。等評等果斷化與學習循環穩定後做。
- **【待辦，2026-10-05 使用者回報】走勢相似度搜尋**：使用者想找「現在的K線走勢像和益(1709)一個月前那段平穩上漲、波動小」的股票。做法構想：在技術篩選候選池（成交金額前120檔）用正規化價格曲線相關係數＋波動度比對指定股票指定期間的走勢；等「本站綜合評等」改版完成後再做（避免同時改 intent.ts）。
- **【已結案 2026-10-05】券資比欄位呈現**：使用者決定改成「融券使用率」（`c85b10d`）。
- **【已確認 2026-10-05】cron-job.org 預熱正常**：台股時段 09:50～13:55 連續 50 次全部 200 OK（歷史頁只留最近50筆），最慢 18.3 秒仍在 30 秒內；美股兩個排程已排程待執行（21:00、10/6 00:00）。預熱回應中台股技術篩選 120 檔有 16 檔抓不到K線，持續觀察。
- **【已知】/search 剛部署後冷載入**：籌碼欄位約 9.5 秒（第二次 2.5 秒），只發生在快取全冷時。

> 只列「尚未結案」的項目；已結案的問題說明（2026-09-14～10-01）已於 2026-10-04 搬到 `PROGRESS-ARCHIVE.md` 的「已結案的已知問題（2026-10-04 自主檔搬入）」章節。

- **【金鑰已於2026-10-01加入Vercel；待美股開盤後實際驗證】Adanos 社群情緒**（開盤前實測：小卡誠實顯示「資料暫缺（美股盤中才會更新）」不破版）。
  加上後第一份快照要等美股盤中（台北約21:30~04:00）有人開美股個股頁/問AI才會抓；三個來源要約80分鐘才會都有資料。
  若要查用量：Redis key `adanos:quota`（伺服器回報剩餘）、`adanos:calls:day:<紐約日期>`、`adanos:calls:month:<UTC年月>`。

- **【金鑰已於2026-10-01加入Vercel，AI問答正式站6題複查通過】AI備援（NVIDIA／Groq）**（正式站無法強制Gemini失敗，備援切換只在本機用假金鑰驗證過）。
  已知限制：NVIDIA 單股/關注清單深度分析偶爾超過40秒逾時（變異大，實測29~44秒），Gemini 本身逾時時 NVIDIA 剩餘時間不足；
  Groq gpt-oss 偶發回空白內容（會自動落到下一家）。

- **【評估後不做】Tavily 網路搜尋補充**：本站「沒資料」最常見是未收錄的主題/概念股，而既有規則刻意禁止列未查證成分股，網路結果（部落格/FB）
  正是該規則要防的來源；實測10筆結果約4筆低品質（房地產站、亂碼頁、FB）；每月1,000次全站共用，且 ask 幾乎每題都有 grounding，
  沒有可靠的「完全沒資料」觸發訊號。若日後要做，建議改成使用者主動按「上網查」＋網域白名單（官方IR/公開資訊觀測站/主流財經媒體）。

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

- **8 大面向框架裡還沒做的塊**（總經已於 2026-10-01 以 FRED 完成，剩法說會逐字稿、供應鏈、期權衍生性商品）：法說會逐字稿與管理層前瞻、終端需求與供應鏈
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

- 本機 Windows PC：對外網路正常、可連正式站；Node.js LTS 已用 winget 安裝；Playwright＋Chromium 裝在系統暫存資料夾（非專案內）。
- `node_modules` 與暫存資料夾裡的 playwright npm 套件**不會一直保留**，接手時若 `npm run build` 找不到 next，先 `npm install`；Playwright 不見就重裝 npm 套件（瀏覽器本體通常還在）。
- `origin` 已改成 `https://hj110b13-Andy@github.com/hj110b13-Andy/Stock-web.git`，避免 Git Credential Manager 跳出選帳號視窗；若又跳出請使用者選一次。repo 本地 git 身分＝`hj110b13-Andy <hj110b13@gmail.com>`（否則 Vercel 會擋部署）。
- 2026-09-11 的完整原始紀錄已搬到 PROGRESS-ARCHIVE.md（搜尋「這次的環境變化」）。
