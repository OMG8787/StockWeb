import type { Earnings, Market } from "@/lib/data";
import { formatTwReportDeadline } from "@/lib/data/twReportDeadline";

export default function EarningsCard({ earnings, currency, market }: { earnings: Earnings | null; currency: string; market: Market }) {
  const isTw = market === "TW";
  const hasAny =
    earnings &&
    (earnings.monthlyRevenueYoyPercent != null ||
      earnings.monthlyRevenueMomPercent != null ||
      earnings.quarterlyEps != null ||
      earnings.epsSurprisePercent != null ||
      earnings.nextEarningsDate ||
      earnings.twReportDeadline);

  return (
    <div className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4">
      <h2 className="mb-3 font-semibold">財報</h2>
      {!hasAny ? (
        <p className="text-sm text-(--text-muted)">目前無法取得這檔股票的財報資料</p>
      ) : (
        <dl className={`grid grid-cols-2 gap-4 text-sm ${isTw ? "sm:grid-cols-3 lg:grid-cols-5" : "sm:grid-cols-4"}`}>
          <div>
            <dt className="text-(--text-muted)">{earnings?.monthlyRevenuePeriod ?? "月營收"}年增率</dt>
            <dd className={`mt-0.5 font-medium tabular-nums ${revenueColorClass(earnings?.monthlyRevenueYoyPercent)}`}>
              {earnings?.monthlyRevenueYoyPercent != null
                ? `${earnings.monthlyRevenueYoyPercent >= 0 ? "+" : ""}${earnings.monthlyRevenueYoyPercent.toFixed(2)}%`
                : "資料暫缺"}
            </dd>
          </div>
          {isTw && (
            <div>
              {/* 月增率＝本月比上月（資料來源的「上月比較增減」），與年增率是同一個月；季節性行業月增常大起大落，要搭配年增率看。 */}
              <dt className="text-(--text-muted)">{earnings?.monthlyRevenuePeriod ?? "月營收"}月增率</dt>
              <dd className={`mt-0.5 font-medium tabular-nums ${revenueColorClass(earnings?.monthlyRevenueMomPercent)}`}>
                {earnings?.monthlyRevenueMomPercent != null
                  ? `${earnings.monthlyRevenueMomPercent >= 0 ? "+" : ""}${earnings.monthlyRevenueMomPercent.toFixed(2)}%`
                  : "資料暫缺"}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-(--text-muted)">{earnings?.quarterlyEpsPeriod ?? "最新一季"} EPS</dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {earnings?.quarterlyEps != null ? `${earnings.quarterlyEps}${currency === "TWD" ? "元" : ""}` : "資料暫缺"}
            </dd>
          </div>
          <div>
            {/* 值可能是負的（低於預期），標籤不能寫死「優於」。台股沒有免費的分析師共識資料，
                直接說明「沒有這種資料」，不寫「資料暫缺」讓人以為是故障。 */}
            <dt className="text-(--text-muted)">EPS較市場預期</dt>
            {isTw ? (
              <dd className="mt-0.5 text-[13px] text-(--text-muted)">台股無公開的市場預期資料</dd>
            ) : (
              <dd className={`mt-0.5 font-medium tabular-nums ${revenueColorClass(earnings?.epsSurprisePercent)}`}>
                {earnings?.epsSurprisePercent != null
                  ? `${earnings.epsSurprisePercent >= 0 ? "+" : ""}${earnings.epsSurprisePercent.toFixed(2)}%`
                  : "資料暫缺"}
              </dd>
            )}
          </div>
          <div>
            {/* 台股沒有統一的「預定公布日」，只顯示法定最晚期限，不冒充公司公告的確切日期。 */}
            <dt className="text-(--text-muted)">下次公布財報日期</dt>
            {isTw ? (
              <dd className="mt-0.5 font-medium tabular-nums">
                {earnings?.twReportDeadline ? formatTwReportDeadline(earnings.twReportDeadline) : "資料暫缺"}
              </dd>
            ) : (
              <dd className="mt-0.5 font-medium tabular-nums">{earnings?.nextEarningsDate ?? "資料暫缺"}</dd>
            )}
          </div>
        </dl>
      )}
      <p className="mt-3 text-[13px] text-(--text-muted)">
        台股資料來源：TWSE／TPEx 公開月營收與季報（金融/保險業無月營收公告）；下次公布日為證券交易法第36條與證交所公告的法定最晚期限（遇假日順延），公司可能提早公布｜美股資料來源：Yahoo
        Finance 季度財報。抓不到時顯示「資料暫缺」，不會用示範數字頂替。
      </p>
    </div>
  );
}

function revenueColorClass(value: number | null | undefined): string {
  if (value == null) return "";
  return value >= 0 ? "text-(--price-up)" : "text-(--price-down)";
}
