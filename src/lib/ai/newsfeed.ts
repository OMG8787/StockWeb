import { cached, mapWithConcurrency, peekCached, writeCached } from "@/lib/data/cache";
import { fetchNewsFeedPool, type NewsItem } from "@/lib/data/news";
import { fetchArticleFullText } from "@/lib/data/articleExtract";
import { getMultiSignalStocks } from "@/lib/data";
import { callAiProviders } from "@/lib/ai/provider";

export interface NewsFeedItem extends NewsItem {
  /** Derived from the item's own identity (link, or source+title when there
   *  is no link) — stable across cache regenerations, not fetch order. */
  id: string;
  /** AI-written plain-language "what this means" — pinned items get theirs
   *  from selectPinned() when the feed is generated; regular items get
   *  theirs lazily, one page at a time, from summarizeItems() below (see
   *  that function for why this can't just run over the whole pool up
   *  front). Absent only while a page's summaries haven't been requested
   *  yet or the AI call for them failed. */
  summary?: string;
  /** Whether `summary` was written from the article's actual extracted body
   *  text ("fulltext") or is a plain-language paraphrase of just the
   *  headline ("headline") — see summarizeBatch in this file for why the
   *  latter is a common, expected, and honest fallback (paywalls, bot-
   *  blocking, slow servers) rather than a bug. Absent whenever `summary`
   *  is (nothing to distinguish). The UI uses this to show a small "根據全文"
   *  marker only on genuinely content-based summaries, never claiming that
   *  distinction for a summary that's actually just a reworded title. */
  summaryKind?: "fulltext" | "headline";
  /** "data" items are this site's own computed figures (technical signals,
   *  institutional flow), not scraped news — `link` points at our own
   *  /stock page rather than an external publisher, and the UI renders
   *  them accordingly ("查看個股" not "查看原文"). */
  kind: "news" | "data";
}

export interface NewsFeed {
  /** Items the AI judged genuinely market-moving (rate decisions, geopolitical
   *  shocks, systemic risk, a mega-cap event big enough to move the whole
   *  index) — never padded to hit a target count; can be empty on a quiet
   *  day. Excluded from `items` so nothing appears twice. */
  pinned: NewsFeedItem[];
  /** Everything else, newest first. */
  items: NewsFeedItem[];
  generatedAt: string;
}

const FEED_TTL_MS = 5 * 60_000; // matches fetchNewsFeedPool's own per-query news.ts cache cadence and the site-wide 5-min standard (see FUNDAMENTALS_TTL_MS in lib/data/index.ts)
const PIN_CANDIDATE_COUNT = 60; // how many of the freshest pool items the AI even considers
const MAX_PINNED = 8;
// How many of each market's technical-signal stocks become "data cards" —
// small on purpose: this feed's job is breadth of real headlines, not a
// second copy of /highlights. See buildDataCards().
const DATA_CARD_COUNT_PER_MARKET = 5;

interface PinnedPick {
  index: number;
  summary: string;
}

/**
 * Asks the AI to pick, from the freshest slice of the pool, which headlines
 * rise to "could move the whole market" — a judgment call no keyword/source
 * heuristic can make reliably (a company-specific headline can be market-
 * moving if it's TSMC, and macro-sounding words appear in plenty of routine
 * stories too) — and to write a short plain-language "what this means"
 * summary for each pick. Returns pool indices rather than reconstructed
 * titles, so there's no risk of the model paraphrasing a headline into
 * something that no longer matches the original item; only `summary` is
 * genuinely AI-authored text.
 */
async function selectPinned(candidates: NewsItem[]): Promise<PinnedPick[]> {
  if (candidates.length === 0) return [];
  const listText = candidates
    .map((item, i) => `${i}. [${item.pubDate.slice(0, 16).replace("T", " ")}] ${item.title}${item.source ? `（${item.source}）` : ""}`)
    .join("\n");
  const system = [
    "你是財經新聞編輯，任務是從下面這份新聞標題清單中，挑出真正屬於「重大消息、可能影響整個台股或美股大盤走勢」等級的新聞——例如央行利率決策、地緣政治衝突、系統性金融風險、重大天災、對整體市場有系統性影響的政策或事件，或是大到足以牽動整個大盤的權值股（例如台積電、蘋果）的重大事件。",
    "一般個股利多利空、單一公司財報、產業內部消息，即使標題聳動，也不算這個等級。",
    "只能從清單的編號中選，不能自己編造清單以外的新聞。清單裡如果真的沒有夠格的大消息，就回傳空陣列，不要為了湊數勉強挑選一般新聞。",
    `最多選 ${MAX_PINNED} 則，依重要性排序，最重要的排第一。`,
    "針對每一則入選的新聞，用繁體中文寫一句話（60字以內）白話說明「這則消息大概在講什麼、可能造成什麼影響」，不要只是重複標題，也不要下單一方向的操作建議，只描述可能的影響方向（例如：可能推升台幣資金外流壓力、可能提振半導體類股信心）。",
    '只能回傳一個 JSON 陣列本身，每個元素是 {"index": 編號, "summary": "重點摘要"}，例如 [{"index":3,"summary":"..."}] 或空陣列 []，不要有任何其他文字、說明或 markdown code block 標記。',
  ].join("\n");

  const result = await callAiProviders(system, [{ role: "user", content: `新聞清單：\n${listText}` }], {
    maxOutputTokens: 1000,
    // 照格式回 JSON 的挑選工作，不需要推理（NVIDIA 備援時會關閉思考模式）。
    simpleTask: true,
  });
  if (!result.usedAi) return [];

  const match = result.answer.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is PinnedPick =>
          p &&
          typeof p === "object" &&
          Number.isInteger(p.index) &&
          p.index >= 0 &&
          p.index < candidates.length &&
          typeof p.summary === "string" &&
          p.summary.trim().length > 0
      )
      .map((p) => ({ index: p.index, summary: p.summary.trim().slice(0, 150) }))
      .slice(0, MAX_PINNED);
  } catch {
    return [];
  }
}

// Deliberately NOT lowered to the site-wide 5-min refresh standard (see
// FUNDAMENTALS_TTL_MS in lib/data/index.ts): this caches an AI gloss of one
// specific, already-published headline's TEXT, which doesn't change once
// written — re-running the same summarization prompt on the same unchanged
// input 5 minutes later would just burn an AI call to get the same answer
// back. FEED_TTL_MS above (now 5 min) is what actually controls how soon a
// genuinely NEW headline shows up at all; this only governs how long an
// individual item's summary, once computed, is reused across that.
const ITEM_SUMMARY_TTL_MS = 12 * 60 * 60_000;
const SUMMARY_MAX_LEN = 100;

// How many items' full-text extraction pipelines (each up to 3 sequential
// HTTP calls — see fetchArticleFullText) run at once. Bounded for the same
// reason mapWithConcurrency exists everywhere else in this codebase: two of
// those calls always hit news.google.com regardless of which publisher the
// article is from, so an unbounded fan-out would hammer one host, and a
// user's page load shouldn't fire dozens of simultaneous outbound requests
// either way. 10 (not lower) matters for the route's 60s budget: each
// item's pipeline has a worst-case ~8s ceiling (its three fetches' own
// timeouts sum to 2.5+2+3.5s), so with up to ~15-20 "news"-kind items
// candidate on a cold page, concurrency 10 keeps this to 2 waves (~16s worst
// case) instead of 6's ~3 waves (~24s) — found by an actual production 504
// (60s timeout) on a `?refresh=1` request that stacks pool regeneration +
// this extraction pass + two AI calls in one request; a real visit without
// `refresh=1` only ever pays for the extraction+AI part, which is the common
// case this budget is really sized for.
const FULLTEXT_FETCH_CONCURRENCY = 10;

interface StoredSummary {
  summary: string;
  kind: "fulltext" | "headline";
}

// Strips the punctuation/spacing that AI echoes back inconsistently (full-
// width vs half-width brackets, separators publishers append like "｜熱門話題")
// so a headline the model quoted back can still be matched against the real
// one it was given.
function normalizeTitle(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/[｜|【】[\]（）()「」『』《》〈〉—–\-_·、,，。.!！?？:：;；"'“”‘’]/g, "")
    .toLowerCase();
}

// True when two headlines are plausibly the same one. Compares on the shorter
// string's leading 12 characters because summarizeBatch only asks the model to
// echo back a prefix, and publishers' own titles often carry trailing section
// names the model drops.
/**
 * Reads the model's JSON array of summary entries, tolerating a response that
 * was cut off mid-array. A truncated reply has no closing bracket, so a plain
 * JSON.parse of the whole thing throws and every summary in the batch is lost
 * — including the ones the model had already finished writing. Falling back to
 * scanning individual {...} objects keeps those, and drops only the partial
 * one at the end.
 */
function parseSummaryEntries(answer: string): Array<Record<string, unknown>> {
  const whole = answer.match(/\[[\s\S]*\]/);
  if (whole) {
    try {
      const parsed = JSON.parse(whole[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to the per-object scan below
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const m of answer.matchAll(/\{[^{}]*\}/g)) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj);
    } catch {
      // ignore this fragment; a malformed one shouldn't discard the rest
    }
  }
  return out;
}

function titlesMatch(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return false;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  const probe = shorter.slice(0, 12);
  return probe.length >= 4 && longer.includes(probe);
}

/**
 * Fills in `summary`/`summaryKind` for regular (non-pinned) feed items — a
 * user asked for every item to have one, not just the AI-curated pinned
 * picks, but summarizing the whole pool (several hundred items, regenerated
 * every 20 minutes) up front would multiply the site's AI usage far beyond
 * what the free tier can sustain. Instead this runs lazily over whatever
 * page the API route actually serves: each item's summary is cached
 * individually by its own stable id (peekCached/writeCached, not the
 * read-or-compute `cached()` — see cache.ts for why), so a page is only ever
 * summarized once across its whole lifetime (repeat views, other visitors,
 * even later pool regenerations that happen to reintroduce the same
 * still-recent article all hit the cache), and only the items actually
 * missing a cached summary trigger real work.
 *
 * For those missing items, this also tries to fetch and extract each
 * article's real body text (see lib/data/articleExtract.ts) before
 * summarizing — a plain headline rephrase was the exact complaint this was
 * built to fix. Extraction fails often (paywalls, bot-blocking, slow
 * servers — see that file's measured ~80% success rate on a real sample,
 * though real-world US-source-heavy pages will do worse given how many wire
 * services block scrapers); whenever it does, that one item falls back to
 * the original headline-only summarization rather than blocking the batch
 * or fabricating content that was never actually retrieved.
 */
export async function summarizeItems(items: NewsFeedItem[]): Promise<NewsFeedItem[]> {
  const candidates = items.filter((item) => !item.summary && item.kind === "news");
  if (candidates.length === 0) return items;

  // Bumped to v2: the cached value's shape changed from a plain string to
  // {summary, kind} (see StoredSummary) when full-text summarization was
  // added. Without a version bump, a pre-existing string-shaped cache entry
  // from before this change reads back "truthy" from peekCached (so it's
  // treated as a hit, not a miss) but has no .summary/.kind properties —
  // silently producing an item with summary=undefined forever until its
  // old TTL expires. Exactly the same bumped-cache-key pattern getNewsFeed
  // already uses below (news-feed:v1 -> v2) for the same reason.
  // Bumped to v3 (v2's reason is above): v2 entries were written before
  // summarizeBatch verified the model's numbering against the echoed title, so
  // some cached summaries belong to a different article than the item they're
  // stored under. Those are already in production Redis with a 12h TTL and
  // can't be selectively evicted, and serving a wrong-article summary is the
  // one failure mode worth paying a full recompute to end immediately.
  const cacheKey = (id: string) => `news-item-summary:v3:${id}`;
  const peeked = await Promise.all(candidates.map((item) => peekCached<StoredSummary>(cacheKey(item.id))));

  const missing: NewsFeedItem[] = [];
  const fromCache = new Map<string, StoredSummary>();
  candidates.forEach((item, i) => {
    const hit = peeked[i];
    if (hit) fromCache.set(item.id, hit);
    else missing.push(item);
  });

  const fullTextById = new Map<string, string>();
  if (missing.length > 0) {
    const texts = await mapWithConcurrency(missing, FULLTEXT_FETCH_CONCURRENCY, (item) =>
      item.link ? fetchArticleFullText(item.link).catch(() => null) : Promise.resolve(null)
    );
    missing.forEach((item, i) => {
      const text = texts[i];
      if (text) fullTextById.set(item.id, text);
    });
  }

  const fromAi = missing.length > 0 ? await summarizeBatch(missing, fullTextById) : new Map<string, StoredSummary>();
  await Promise.all(
    Array.from(fromAi.entries()).map(([id, stored]) => writeCached(cacheKey(id), stored, ITEM_SUMMARY_TTL_MS))
  );

  return items.map((item) => {
    const stored = fromCache.get(item.id) ?? fromAi.get(item.id);
    if (item.summary) return item;
    return stored ? { ...item, summary: stored.summary, summaryKind: stored.kind } : item;
  });
}

async function summarizeBatch(items: NewsFeedItem[], fullTextById: Map<string, string>): Promise<Map<string, StoredSummary>> {
  const listText = items
    .map((item, i) => {
      const fullText = fullTextById.get(item.id);
      const header = `${i}. ${item.title}${item.source ? `（${item.source}）` : ""}`;
      return fullText ? `${header}\n【全文摘錄】\n${fullText}` : header;
    })
    .join("\n\n");
  const system = [
    "你是財經新聞編輯，針對下面清單裡的每一則新聞，用繁體中文寫一句話（40字以內）白話說明重點，讓完全沒有股票背景的人也能一眼看懂，不要加上投資建議。",
    "清單裡每一則如果附有「【全文摘錄】」段落，那是這篇新聞實際的內文開頭，請根據這段實際內容寫摘要（可以引用內文提到的具體數字、原因、影響等實質細節），不要只是換句話重複標題。",
    "如果某一則沒有附「【全文摘錄】」（只有標題），才依標題本身合理描述大意，這種情況本來就只能做到換句話說明標題，不用假裝有更多資訊。",
    '只能回傳一個 JSON 陣列本身，每個元素是 {"index": 編號, "title": "那一則新聞標題的前12個字", "summary": "重點摘要"}，順序或數量不用跟輸入一致，每一則清單裡的新聞都要有對應的一筆，不要有其他文字、說明或 markdown code block 標記。',
    "「title」欄位務必原封不動抄下那一則新聞標題開頭的文字（不要翻譯、不要改寫），這是用來確認你的摘要有對到正確的那一則新聞。",
  ].join("\n");

  try {
    // Budget per item, measured against what this actually emits: an index, a
    // 12-character echoed title and a ~40-character Chinese summary, which in
    // CJK runs well over one token per character. The previous 60/item was
    // already near the edge for summary-only output; adding the title field
    // pushed a real 10-item page over it, and a response truncated at
    // MAX_TOKENS ends mid-JSON, fails to parse, and silently drops the whole
    // batch to zero summaries (observed in production right after the title
    // check shipped). The floor matters as much as the multiplier — a short
    // batch still has to fit entire objects.
    const result = await callAiProviders(system, [{ role: "user", content: `新聞清單：\n${listText}` }], {
      maxOutputTokens: Math.max(1200, items.length * 130),
      simpleTask: true,
      // 模型要原封不動抄回標題開頭做比對，標題若含簡體字被轉成繁體就會對不上。
      normalizeZhTw: false,
    });
    if (!result.usedAi) return new Map();
    const parsed = parseSummaryEntries(result.answer);
    if (!parsed.length) return new Map();
    const map = new Map<string, StoredSummary>();
    for (const entry of parsed) {
      const rawIndex = entry.index;
      const rawSummary = entry.summary;
      if (
        Number.isInteger(rawIndex) &&
        (rawIndex as number) >= 0 &&
        (rawIndex as number) < items.length &&
        typeof rawSummary === "string" &&
        rawSummary.trim().length > 0
      ) {
        // The model numbers these itself, and it demonstrably miscounts when
        // the list interleaves long 【全文摘錄】 blocks between headlines —
        // production served a simplywall.st AI-chip story carrying a summary
        // about 國泰金's GDP forecast (a different item entirely). A wrong
        // summary is worse than none here: it reads as a confidently
        // fabricated account of an article nobody wrote. So the echoed title
        // decides which item this summary really belongs to, and the model's
        // own index is only trusted when it has no title to check against
        // (older/uncooperative responses stay on the previous behaviour
        // rather than losing every summary).
        const echoed = typeof entry.title === "string" ? entry.title.trim() : "";
        let target = rawIndex as number;
        if (echoed) {
          if (!titlesMatch(items[target].title, echoed)) {
            const found = items.findIndex((it) => titlesMatch(it.title, echoed));
            if (found < 0) continue;
            target = found;
          }
        }
        const item = items[target];
        if (map.has(item.id)) continue;
        map.set(item.id, {
          summary: rawSummary.trim().slice(0, SUMMARY_MAX_LEN),
          kind: fullTextById.has(item.id) ? "fulltext" : "headline",
        });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * "不能只依賴新聞" — real, already-trusted structured data (technical
 * signals computed from actual price/volume history, same engine as
 * /highlights) mixed into the feed as its own item type, not another
 * headline paraphrase. Deliberately small and deliberately reusing existing,
 * already-verified data functions rather than standing up a new source —
 * broader dimensions (法說會/供應鏈/總體經濟/期權 from the 8-面向 reference)
 * would each need a genuinely new pipeline and are tracked separately, not
 * attempted here.
 */
async function buildDataCards(): Promise<NewsItem[]> {
  try {
    const [twMomentum, usMomentum] = await Promise.all([
      getMultiSignalStocks("TW").catch(() => []),
      getMultiSignalStocks("US").catch(() => []),
    ]);
    const now = new Date().toISOString();
    const cards: NewsItem[] = [];
    for (const s of twMomentum.slice(0, DATA_CARD_COUNT_PER_MARKET)) {
      cards.push({
        title: `${s.name}(${s.symbol}) 現價 ${s.price}（${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%）：${s.signals.map((sig) => sig.label).join("、")}`,
        source: "StockRadar 技術訊號（真實數據，非新聞）",
        pubDate: now,
        link: `/stock/${s.symbol}?market=TW`,
      });
    }
    for (const s of usMomentum.slice(0, DATA_CARD_COUNT_PER_MARKET)) {
      cards.push({
        title: `${s.name}(${s.symbol}) ${s.price}（${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%）: ${s.signals.map((sig) => sig.label).join(", ")}`,
        source: "StockRadar 技術訊號（真實數據，非新聞）",
        pubDate: now,
        link: `/stock/${s.symbol}?market=US`,
      });
    }
    return cards;
  } catch {
    return [];
  }
}

export async function getNewsFeed(forceRefresh = false): Promise<NewsFeed> {
  return cached(
    // Bumped from v1: the cached shape changed (summary/kind fields), so a
    // stale v1 entry read back after deploy would be missing them rather
    // than erroring — a fresh key just makes that a clean cache miss.
    "news-feed:v2",
    FEED_TTL_MS,
    async () => {
      const [newsPool, dataCards] = await Promise.all([fetchNewsFeedPool(), buildDataCards()]);
      const merged = [...dataCards, ...newsPool].sort((a, b) => b.pubDate.localeCompare(a.pubDate));

      const withIds: NewsFeedItem[] = merged.map((item) => ({
        ...item,
        id: item.link ?? `${item.source ?? ""}|${item.title}`,
        kind: item.link?.startsWith("/stock/") ? "data" : "news",
      }));

      const picks = await selectPinned(merged.slice(0, PIN_CANDIDATE_COUNT)).catch(() => []);
      const pinnedIndexSet = new Set(picks.map((p) => p.index));

      const pinned = picks
        .map((p): NewsFeedItem | undefined => (withIds[p.index] ? { ...withIds[p.index], summary: p.summary } : undefined))
        .filter((item): item is NewsFeedItem => item !== undefined);
      const items = withIds.filter((_, i) => !pinnedIndexSet.has(i));

      return { pinned, items, generatedAt: new Date().toISOString() };
    },
    { forceRefresh }
  );
}
