/**
 * Merges a TWSE whole-market map with TPEx's equivalent for the same
 * category (fundamentals, monthly revenue, quarterly EPS, institutional
 * trading, margin trading, material announcements all follow this exact
 * shape) — no symbol-collision risk (see getTwUniverse's comment: TW codes
 * come from one shared national registry). Each side is wrapped in its own
 * catch so a TPEx endpoint outage never takes down TWSE data for that
 * category, or vice versa — same "degrade per source" pattern as
 * getIndices' per-index try/catch and getTwUniverse's per-exchange fetch.
 */
export async function mergeTwMaps<V>(
  fetchTwse: () => Promise<Map<string, V>>,
  fetchTpex: () => Promise<Map<string, V>>,
  // 第三個板（興櫃）是選填：只有月營收跟季報 EPS 這兩類資料櫃買中心有替興櫃
  // 公布，本益比/三大法人/融資融券/重大訊息那幾類對興櫃根本不存在，那些呼叫
  // 端就只傳兩個資料源，不會憑空生出一份空的興櫃資料來假裝有查過。
  fetchEmerging?: () => Promise<Map<string, V>>
): Promise<Map<string, V>> {
  const [twse, tpex, emerging] = await Promise.all([
    fetchTwse().catch(() => new Map<string, V>()),
    fetchTpex().catch(() => new Map<string, V>()),
    fetchEmerging ? fetchEmerging().catch(() => new Map<string, V>()) : Promise.resolve(new Map<string, V>()),
  ]);
  return new Map([...twse, ...tpex, ...emerging]);
}
