import { cached, fetchWithTimeout } from "./cache";

export interface NewsItem {
  title: string;
  source?: string;
  pubDate: string;
  /** Article URL (a Google News redirect that forwards to the original
   *  publisher page) — absent from older cached news.ts callers that only
   *  ever displayed title+source as plain text; the news feed page is what
   *  actually needs to link out to a source. */
  link?: string;
}

const NEWS_TTL_MS = 5 * 60_000; // site-wide 5-min refresh standard (see FUNDAMENTALS_TTL_MS in lib/data/index.ts) so new headlines surface promptly

/** Which Google News regional edition to search — each surfaces a different
 *  set of outlets (zh-TW pulls in Chinese-language financial media, en-US
 *  pulls in English-language wires like Reuters/Bloomberg/MarketWatch that
 *  the zh-TW edition mostly doesn't carry), not just a translation of the
 *  same underlying stories. */
type NewsLocale = "zh-TW" | "en-US";

const LOCALE_QUERY_PARAMS: Record<NewsLocale, string> = {
  "zh-TW": "hl=zh-TW&gl=TW&ceid=TW:zh-Hant",
  "en-US": "hl=en-US&gl=US&ceid=US:en",
};

/**
 * Google News' RSS search — free, no API key, and (unlike scraping any one
 * publisher's site) a stable, documented URL shape that aggregates many
 * sources at once. This is what fills the "資訊面" gap the AI used to have
 * no source for at all (it only ever saw price/technical data): callers
 * pass a market or company query and get back recent real headlines with
 * real publish dates, never a fabricated summary of "what's in the news."
 */
async function fetchNewsRaw(query: string, limit: number, locale: NewsLocale): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${LOCALE_QUERY_PARAMS[locale]}`;
  const res = await fetchWithTimeout(url, 6000, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  const xml = await res.text();
  return parseRssItems(xml, limit);
}

/**
 * Deliberately not a general XML parser — Google News' RSS is a flat,
 * predictable <item><title>/<pubDate></item> structure with no nesting, so
 * a couple of regexes cover it without pulling in an XML/RSS library for
 * one feed shape.
 */
function parseRssItems(xml: string, limit: number): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while (items.length < limit && (match = itemRegex.exec(xml))) {
    const block = match[1];
    const rawTitle = block.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1];
    // Google News RSS carries the publisher name in a dedicated <source> tag
    // (e.g. `<source url="https://tw.news.yahoo.com">Yahoo新聞</source>`) —
    // more reliable than guessing from the title text, which is what this
    // used to do (splitting on " - ", which breaks for any title that
    // legitimately contains " - " itself).
    const taggedSource = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1];
    if (!rawTitle) continue;
    let title = decodeXmlEntities(rawTitle);
    // The " - <source>" suffix (e.g. "... - Yahoo新聞") is present in the
    // title REGARDLESS of whether the <source> tag also exists, so this
    // always needs stripping — only which string becomes `source` differs
    // (the tag, when present, is more reliable than re-parsing the title).
    const titleSourceMatch = title.match(/^(.*) - ([^-]+)$/);
    if (titleSourceMatch) title = titleSourceMatch[1].trim();
    const source = taggedSource ? decodeXmlEntities(taggedSource).trim() : titleSourceMatch?.[2]?.trim();
    items.push({
      title,
      source,
      pubDate: pubDate ? new Date(pubDate).toISOString() : "",
      link: link ? decodeXmlEntities(link).trim() : undefined,
    });
  }
  return items;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Cached wrapper — same query+locale within the TTL window shares one fetch. */
export async function fetchNews(query: string, limit = 6, locale: NewsLocale = "zh-TW"): Promise<NewsItem[]> {
  try {
    return await cached(`news:${locale}:${query}`, NEWS_TTL_MS, () => fetchNewsRaw(query, limit, locale));
  } catch {
    return [];
  }
}

/**
 * Fetches the same query across several Google News regional editions in
 * parallel and merges them, de-duplicated by title — used for US stocks/
 * market news so the grounding gets genuine English-language wire coverage
 * (Reuters/Bloomberg/MarketWatch etc.) alongside zh-TW coverage, not just
 * one edition's view of "what's in the news."
 */
export async function fetchNewsMulti(query: string, perLocaleLimit: number, locales: NewsLocale[]): Promise<NewsItem[]> {
  return dedupeNews(await Promise.all(locales.map((locale) => fetchNews(query, perLocaleLimit, locale))).then((l) => l.flat()));
}

export function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const item of items) {
    const key = item.title.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/**
 * US market-wide news needs its own English-language query ("US stock
 * market") for the en-US Google News edition — reusing the Chinese "美股"
 * query there returns poorly-matched results, since it's searching an
 * English-language edition with a Chinese term. Shared by the chat's market
 * news section and the daily brief, so this query-pairing logic lives in
 * exactly one place.
 */
export async function fetchUsMarketNews(perLocaleLimit = 5): Promise<NewsItem[]> {
  const [zh, en] = await Promise.all([
    fetchNews("美股", perLocaleLimit).catch(() => []),
    fetchNews("US stock market", perLocaleLimit, "en-US").catch(() => []),
  ]);
  return dedupeNews([...zh, ...en]);
}

/**
 * Topics fanned out for the news feed page (/news) — a single query already
 * returns up to ~100 items from Google News, but all from one search term's
 * framing. Spreading across TW-market, US-market, macro and sector queries
 * (some also pulling the en-US edition) is what gives the feed enough real
 * breadth and volume to page through, rather than 100 near-duplicate
 * results about one narrow topic.
 */
const FEED_TOPICS: Array<{ query: string; locales: NewsLocale[] }> = [
  { query: "台股", locales: ["zh-TW"] },
  { query: "台積電", locales: ["zh-TW"] },
  { query: "台股 外資", locales: ["zh-TW"] },
  { query: "台灣 央行 升息", locales: ["zh-TW"] },
  { query: "電子股 半導體", locales: ["zh-TW"] },
  { query: "台股 金融股", locales: ["zh-TW"] },
  { query: "美股", locales: ["zh-TW", "en-US"] },
  { query: "Fed interest rate", locales: ["zh-TW", "en-US"] },
  { query: "那斯達克 道瓊", locales: ["zh-TW"] },
  { query: "CPI inflation", locales: ["zh-TW", "en-US"] },
  { query: "AI chip semiconductor", locales: ["zh-TW", "en-US"] },
  { query: "地緣政治 石油", locales: ["zh-TW"] },
];

const FEED_PER_QUERY_LIMIT = 40;

// A broad query like "CPI inflation" or "地緣政治 石油" doesn't just return
// recent news — Google News also surfaces evergreen tool/landing pages it
// happens to index for that topic (a Fear & Greed Index widget, a "how to
// buy US stocks" guide) and old articles that still rank, with no built-in
// recency floor. An Opus QA pass scrolled to the very end of the feed and
// found ~23% of items over 30 days old, some from 2022 — directly
// contradicting the page's own "近期新聞" framing. This is a page-level
// concern (not the single-stock/market-news grounding fetchNews() also
// serves, which only ever asks for a handful of items and reads fine
// without a cutoff), so the filter lives here rather than in fetchNews().
const FEED_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/**
 * Builds the raw pool the news feed page pages through: every topic query
 * fetched in parallel, merged, de-duplicated by title, filtered to a recency
 * window, newest first. Callers (getNewsFeed in lib/ai/newsfeed.ts) are
 * expected to cache this — it fans out to a dozen+ real HTTP requests, not
 * something to redo per page scroll.
 */
export async function fetchNewsFeedPool(): Promise<NewsItem[]> {
  const results = await Promise.all(
    FEED_TOPICS.flatMap((topic) =>
      topic.locales.map((locale) => fetchNews(topic.query, FEED_PER_QUERY_LIMIT, locale).catch(() => []))
    )
  );
  const cutoff = Date.now() - FEED_MAX_AGE_MS;
  const merged = dedupeNews(results.flat().filter((item) => item.pubDate && Date.parse(item.pubDate) >= cutoff));
  merged.sort((a, b) => b.pubDate.localeCompare(a.pubDate));
  return merged;
}
