import {
  buzzLabel,
  formatSentimentTime,
  getUsStockSentiment,
  isSentimentConfigured,
  LEAN_LABEL,
  SENTIMENT_SOURCE_LABEL,
  SENTIMENT_SOURCES,
  sentimentLean,
  SMALL_SAMPLE_MENTIONS,
  TREND_LABEL,
  type StockSentiment,
} from "@/lib/data/sentiment";

const SHELL = "rounded-lg border border-(--gridline) bg-(--surface-1) p-4 sm:p-6";

function Header() {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-semibold">社群情緒</h2>
      <p className="mt-1 text-xs text-(--text-muted)">
        來源：Adanos 彙整 Reddit／X／財經新聞近7日討論。這是網路社群的多空氣氛，不是事實或財報數據，樣本可能很小，僅供參考，不宜當作買賣依據。
      </p>
    </div>
  );
}

export function SocialSentimentView({ sentiment }: { sentiment: StockSentiment | null }) {
  if (!sentiment) {
    return (
      <section className={SHELL} aria-label="社群情緒">
        <Header />
        <p className="text-sm text-(--text-secondary)">社群情緒資料暫缺（美股盤中才會更新，請稍後再看）。</p>
      </section>
    );
  }
  return (
    <section className={SHELL} aria-label="社群情緒">
      <Header />
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {SENTIMENT_SOURCES.map((src) => {
          const entry = sentiment.sources[src];
          const row = entry?.row ?? null;
          return (
            <div key={src} className="min-w-0 rounded-md bg-(--surface-2) px-3 py-2.5">
              <p className="text-sm text-(--text-muted)">{SENTIMENT_SOURCE_LABEL[src]}</p>
              {!entry ? (
                <p className="mt-1 text-sm text-(--text-secondary)">資料暫缺</p>
              ) : !row ? (
                <p className="mt-1 text-sm text-(--text-secondary)">不在近7日熱門討論前 {entry.listSize} 名（討論很少）</p>
              ) : (
                <>
                  <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                    {/* 樣本太小時不放大字結論（例如只有2則推文100%看多），只列比例供參考 */}
                    {row.mentions < SMALL_SAMPLE_MENTIONS ? (
                      <span className="text-base font-medium text-(--text-secondary)">樣本太少</span>
                    ) : (
                      <span className="text-xl font-bold">{LEAN_LABEL[sentimentLean(row)]}</span>
                    )}
                    {row.bullishPct != null && row.bearishPct != null && (
                      <span className="text-sm tabular-nums text-(--text-secondary)">
                        看多 {row.bullishPct}%・看空 {row.bearishPct}%
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-sm tabular-nums text-(--text-secondary)">
                    討論熱度 {buzzLabel(row.buzz)}（{Math.round(row.buzz)}/100）
                    {row.trend && `・${TREND_LABEL[row.trend]}`}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-(--text-muted)">
                    提及 {row.mentions.toLocaleString("en-US")} 次
                    {row.mentions < SMALL_SAMPLE_MENTIONS && "（樣本很小）"}
                  </p>
                </>
              )}
              {entry && <p className="mt-1 text-xs text-(--text-muted)">資料時間 {formatSentimentTime(entry.fetchedAt)}（台北）</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** 美股個股頁的社群情緒小卡；缺金鑰時整塊不顯示。頁面用 <Suspense> 包起來，不拖慢其他區塊。 */
export default async function SocialSentimentCard({ symbol }: { symbol: string }) {
  if (!isSentimentConfigured()) return null;
  const sentiment = await getUsStockSentiment(symbol).catch(() => null);
  return <SocialSentimentView sentiment={sentiment} />;
}
