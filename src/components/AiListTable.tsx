"use client";

import Link from "next/link";
import WatchlistButton from "@/components/WatchlistButton";
import { AiTagBadges, type AiHoldRow, type AiPickRow } from "@/components/AiListsContext";
import { formatPercent, formatPrice, priceDirectionClass } from "@/lib/format";
import { useTwQuotes } from "@/lib/useTwQuotes";

/**
 * 「我的關注」裡的兩份 AI 名單（AI 模擬持股、AI 建議清單）的表格。每一列最前面有 ★：
 * 點一下就加入（或取消）「我的關注」清單，跟個股頁、關注清單同一個 WatchlistButton／同一份 localStorage 與帳號同步。
 * 現價用批次報價 API 即時更新（盤中 30 秒）；模擬持股的成本、股數、損益來自 AI 模擬組合本身。
 */

const th = "py-2 pr-2 text-left text-xs font-medium text-(--text-muted)";
const thR = "py-2 pr-2 text-right text-xs font-medium text-(--text-muted)";

/** hide：這張表本身就是持股（或建議）名單，不用再標同一種；另一種（例如持股表裡這檔 AI 也建議）才標出來 */
function NameCell({ symbol, name, hide }: { symbol: string; name: string; hide: "held" | "picked" }) {
  return (
    <td className="py-2 pr-2">
      <Link href={`/stock/${symbol}?market=TW`} prefetch={false} className="block whitespace-nowrap font-medium hover:text-(--accent)">
        {name}
        <span className="block text-xs font-normal tabular-nums text-(--text-muted)">
          {symbol}
          <AiTagBadges symbol={symbol} market="TW" hide={hide} />
        </span>
      </Link>
    </td>
  );
}

export function AiHoldingsTable({ rows }: { rows: AiHoldRow[] }) {
  const quotes = useTwQuotes(rows.map((r) => r.symbol));
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-(--text-muted)">AI 模擬組合目前沒有持股（交易日 09:30、11:00、12:30 依本站評等自動買進）。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-(--gridline)">
            <th className={th} aria-label="加入關注" />
            <th className={th}>代碼／名稱</th>
            <th className={thR}>現價</th>
            <th className={thR}>漲跌幅</th>
            <th className={thR}>持有股數</th>
            <th className={thR}>平均成本</th>
            <th className={thR} title="現價相對平均成本的損益金額與百分比，不是今日漲跌幅">未實現損益</th>
            <th className={thR} title="占 AI 模擬組合淨值的比例">占淨值</th>
            <th className={thR}>買進日</th>
            <th className={thR}>停損價</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const q = quotes[r.symbol.toUpperCase()];
            const price = q?.price ?? r.price;
            const change = q?.changePercent ?? r.changePercent;
            // 損益用組合本身的數字（已扣假設賣出成本，跟首頁卡片、/portfolio 一致），不用即時價重算，避免三處數字對不上
            const { pnl: pnlAmount, pnlPct } = r;
            return (
              <tr key={r.symbol} className="whitespace-nowrap border-b border-(--gridline) last:border-0 hover:bg-(--page-plane)">
                <td className="py-2 pr-1">
                  <WatchlistButton symbol={r.symbol} market="TW" name={r.name} />
                </td>
                <NameCell symbol={r.symbol} name={r.name} hide="held" />
                <td className="py-2 pr-2 text-right tabular-nums">{formatPrice(price, "TWD")}</td>
                <td className={`py-2 pr-2 text-right tabular-nums ${change != null ? priceDirectionClass(change) : "text-(--text-muted)"}`}>{change != null ? formatPercent(change) : "—"}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{r.shares.toLocaleString()}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatPrice(r.avgCost, "TWD")}</td>
                <td className={`py-2 pr-2 text-right tabular-nums ${priceDirectionClass(pnlPct)}`} title="未實現損益：現價相對平均成本的漲跌（已扣假設賣出成本，與首頁卡片、完整持股頁相同），不是今日漲跌幅">
                  {pnlAmount > 0 ? "+" : ""}
                  {Math.round(pnlAmount).toLocaleString("en-US")} 元 <span className="text-xs">({formatPercent(pnlPct)})</span>
                </td>
                <td className="py-2 pr-2 text-right tabular-nums text-(--text-secondary)">{r.weightPct.toFixed(1)}%</td>
                <td className="py-2 pr-2 text-right tabular-nums text-(--text-secondary)">{r.buyDay}</td>
                <td className="py-2 pr-2 text-right tabular-nums text-(--text-secondary)">{r.stopPrice != null ? formatPrice(r.stopPrice, "TWD") : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AiPicksTable({ rows }: { rows: AiPickRow[] }) {
  const quotes = useTwQuotes(rows.map((r) => r.symbol));
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-(--text-muted)">AI 建議清單目前是空的（還沒有符合條件的建議買進）。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-(--gridline)">
            <th className={th} aria-label="加入關注" />
            <th className={th}>代碼／名稱</th>
            <th className={thR}>現價</th>
            <th className={thR}>漲跌幅</th>
            <th className={th}>評等與操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const q = quotes[r.symbol.toUpperCase()];
            return (
              <tr key={r.symbol} className="border-b border-(--gridline) align-top last:border-0 hover:bg-(--page-plane)">
                <td className="py-2 pr-1">
                  <WatchlistButton symbol={r.symbol} market="TW" name={r.name} />
                </td>
                <NameCell symbol={r.symbol} name={r.name} hide="picked" />
                <td className="whitespace-nowrap py-2 pr-2 text-right tabular-nums">{q ? formatPrice(q.price, "TWD") : "—"}</td>
                <td className={`whitespace-nowrap py-2 pr-2 text-right tabular-nums ${q ? priceDirectionClass(q.changePercent) : "text-(--text-muted)"}`}>{q ? formatPercent(q.changePercent) : "—"}</td>
                <td className="py-2 pr-2 text-xs leading-relaxed text-(--text-secondary)">
                  <span className="font-medium text-(--text-primary)">{r.label}</span>
                  {r.plan && <span className="block">操作：{r.plan}</span>}
                  {r.confidence && <span className="block text-(--text-muted)">{r.confidence}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
