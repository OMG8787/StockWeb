import type { Earnings } from "@/lib/data";

export default function EarningsCard({ earnings, currency }: { earnings: Earnings | null; currency: string }) {
  const hasAny =
    earnings &&
    (earnings.monthlyRevenueYoyPercent != null ||
      earnings.quarterlyEps != null ||
      earnings.epsSurprisePercent != null ||
      earnings.nextEarningsDate);

  return (
    <div className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4">
      <h2 className="mb-3 font-semibold">財報</h2>
      {!hasAny ? (
        <p className="text-sm text-(--text-muted)">目前無法取得這檔股票的財報資料</p>
      ) : (
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-(--text-muted)">{earnings?.monthlyRevenuePeriod ?? "月營收"}年增率</dt>
            <dd className={`mt-0.5 font-medium tabular-nums ${revenueColorClass(earnings?.monthlyRevenueYoyPercent)}`}>
              {earnings?.monthlyRevenueYoyPercent != null
                ? `${earnings.monthlyRevenueYoyPercent >= 0 ? "+" : ""}${earnings.monthlyRevenueYoyPercent.toFixed(2)}%`
                : "資料暫缺"}
            </dd>
          </div>
          <div>
            <dt className="text-(--text-muted)">{earnings?.quarterlyEpsPeriod ?? "最新一季"} EPS</dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {earnings?.quarterlyEps != null ? `${earnings.quarterlyEps}${currency === "TWD" ? "元" : ""}` : "資料暫缺"}
            </dd>
          </div>
          <div>
            {/* 值可能是負的（低於預期），標籤不能寫死「優於」 */}
            <dt className="text-(--text-muted)">EPS較市場預期</dt>
            <dd className={`mt-0.5 font-medium tabular-nums ${revenueColorClass(earnings?.epsSurprisePercent)}`}>
              {earnings?.epsSurprisePercent != null
                ? `${earnings.epsSurprisePercent >= 0 ? "+" : ""}${earnings.epsSurprisePercent.toFixed(2)}%`
                : "資料暫缺"}
            </dd>
          </div>
          <div>
            <dt className="text-(--text-muted)">下次公布財報日期</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{earnings?.nextEarningsDate ?? "資料暫缺"}</dd>
          </div>
        </dl>
      )}
      <p className="mt-3 text-[13px] text-(--text-muted)">
        台股資料來源：TWSE／TPEx 公開月營收與季報（金融/保險業無月營收公告）｜美股資料來源：Yahoo
        Finance 季度財報。抓不到時顯示「資料暫缺」，不會用示範數字頂替。
      </p>
    </div>
  );
}

function revenueColorClass(value: number | null | undefined): string {
  if (value == null) return "";
  return value >= 0 ? "text-(--price-up)" : "text-(--price-down)";
}
