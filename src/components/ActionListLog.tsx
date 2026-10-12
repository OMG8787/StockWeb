"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ActionListLogEntry } from "@/lib/ai/actionListLog";
import { clientRefreshMs } from "@/lib/autoRefresh";
import { formatPercent, formatPrice, priceDirectionClass } from "@/lib/format";
import { useFetchOnce } from "@/lib/useFetchOnce";
import { useTwQuotes } from "@/lib/useTwQuotes";
import WatchlistButton from "./WatchlistButton";

/**
 * 「建議清單紀錄」（2026-10-12 使用者：名單跳太快，要能回頭複查 AI 對不對）。
 * 每次 AI 建議名單有股票加入或移出都會記一筆（時間、當時價位、評等、把握程度、操作計畫、理由），
 * 這裡依日期列出，並用現價算出「加入後至今漲跌」，最上面統計加入過的股票至今幾檔上漲、幾檔下跌。
 * 價位是「記錄當下」的評等計算價，現價是批次報價（盤中 30 秒更新）；紀錄只增不改。
 */

const PAGE = 40;

function EntryRow({ e, now }: { e: ActionListLogEntry; now: number | undefined }) {
  const since = e.event === "add" && e.price && now ? ((now / e.price) - 1) * 100 : null;
  return (
    <li className="border-b border-(--gridline) py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="tabular-nums text-(--text-muted)">{e.time}</span>
        <span className={`rounded px-1.5 py-px text-xs font-medium ${e.event === "add" ? "bg-(--price-up)/15 text-(--price-up)" : "bg-(--page-plane) text-(--text-secondary)"}`}>
          {e.event === "add" ? "➕ 加入" : "➖ 移出"}
        </span>
        <WatchlistButton symbol={e.symbol} market="TW" name={e.name} />
        <Link href={`/stock/${e.symbol}?market=TW`} prefetch={false} className="font-medium hover:text-(--accent)">
          {e.name} <span className="text-xs font-normal tabular-nums text-(--text-muted)">{e.symbol}</span>
        </Link>
        <span className="tabular-nums text-(--text-secondary)">{e.event === "add" ? "加入價" : "移出時"} {e.price != null ? formatPrice(e.price, "TWD") : "—"}</span>
        {since != null && (
          <span className={`tabular-nums font-medium ${priceDirectionClass(since)}`}>
            至今 {formatPercent(since)}（現價 {formatPrice(now!, "TWD")}）
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-(--text-secondary)">{e.label}</div>
      {(e.plan || e.reason || e.confidence) && (
        <details className="mt-1 text-xs text-(--text-muted)">
          <summary className="cursor-pointer select-none">當時的理由與操作計畫</summary>
          <div className="mt-1 space-y-0.5 leading-relaxed text-(--text-secondary)">
            {e.confidence && <p>{e.confidence}</p>}
            {e.plan && <p>操作：{e.plan}</p>}
            {e.reason && <p>理由：{e.reason}</p>}
            <p className="text-(--text-muted)">
              當時名單共 {e.listSize} 檔（{e.mode === "next-open" ? "明日操作建議" : "今日建議"}）
            </p>
          </div>
        </details>
      )}
    </li>
  );
}

export default function ActionListLog() {
  const { data, failed } = useFetchOnce<{ entries: ActionListLogEntry[] }>("/api/action-list-log", clientRefreshMs);
  const [shown, setShown] = useState(PAGE);
  const entries = data?.entries ?? null;
  // 現價：只查「加入」過的股票（去重、最多 60 檔）
  const symbols = useMemo(() => [...new Set((entries ?? []).filter((e) => e.event === "add").map((e) => e.symbol))].slice(0, 60), [entries]);
  const quotes = useTwQuotes(symbols);

  const stats = useMemo(() => {
    if (!entries) return null;
    // 每檔股票取「第一次加入」的價位來算至今漲跌（同一檔重複進出不重複算）
    const first = new Map<string, ActionListLogEntry>();
    for (const e of [...entries].reverse()) if (e.event === "add" && e.price && !first.has(e.symbol)) first.set(e.symbol, e);
    let up = 0;
    let down = 0;
    let sum = 0;
    let n = 0;
    for (const [sym, e] of first) {
      const q = quotes[sym.toUpperCase()];
      if (!q || !e.price) continue;
      const r = (q.price / e.price - 1) * 100;
      n++;
      sum += r;
      if (r > 0) up++;
      else if (r < 0) down++;
    }
    return { total: first.size, evaluated: n, up, down, avg: n ? sum / n : null };
  }, [entries, quotes]);

  const days = useMemo(() => {
    const out: Array<{ day: string; items: ActionListLogEntry[] }> = [];
    for (const e of (entries ?? []).slice(0, shown)) {
      const last = out[out.length - 1];
      if (last && last.day === e.day) last.items.push(e);
      else out.push({ day: e.day, items: [e] });
    }
    return out;
  }, [entries, shown]);

  return (
    <section id="action-list-log" className="rounded-lg border border-(--gridline) bg-(--surface-1) p-5">
      <h2 className="font-semibold">📜 建議清單紀錄</h2>
      <p className="mt-1 text-xs text-(--text-muted)">
        AI 建議名單每次有股票加入或移出都會記下時間、當時價位、評等與理由，方便你之後回頭檢查 AI 的建議準不準。價位是記錄當下的評等計算價；紀錄只會新增、不會修改。
      </p>
      {failed ? (
        <p className="mt-3 text-sm text-(--text-muted)">紀錄暫時無法取得，請稍後再試。</p>
      ) : entries === null ? (
        <p className="mt-3 text-sm text-(--text-muted)">載入中…</p>
      ) : entries.length === 0 ? (
        <p className="mt-3 text-sm text-(--text-muted)">還沒有紀錄：名單下一次有進出時就會開始記錄。</p>
      ) : (
        <>
          {stats && stats.evaluated > 0 && (
            <p className="mt-3 rounded-md bg-(--surface-2) px-3 py-2 text-sm">
              記錄過 <b>{stats.total}</b> 檔股票的加入；目前查得到現價的 {stats.evaluated} 檔裡：
              <span className="text-(--price-up)"> 上漲 {stats.up} 檔</span>、<span className="text-(--price-down)">下跌 {stats.down} 檔</span>
              {stats.avg != null && <>，平均 <span className={`font-medium ${priceDirectionClass(stats.avg)}`}>{formatPercent(stats.avg)}</span></>}
              <span className="text-xs text-(--text-muted)">（以第一次加入的價位算到現在，未扣手續費；僅供複查參考）</span>
            </p>
          )}
          <div className="mt-3 space-y-4">
            {days.map((d) => (
              <div key={d.day}>
                <h3 className="text-sm font-semibold text-(--text-secondary)">{d.day}</h3>
                <ul>
                  {d.items.map((e, i) => (
                    <EntryRow key={`${e.at}-${e.symbol}-${e.event}-${i}`} e={e} now={quotes[e.symbol.toUpperCase()]?.price} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {entries.length > shown && (
            <button type="button" className="mt-3 rounded-md border border-(--gridline) px-3 py-1.5 text-xs hover:bg-(--page-plane)" onClick={() => setShown(shown + PAGE)}>
              顯示更早的紀錄（還有 {entries.length - shown} 筆）
            </button>
          )}
        </>
      )}
    </section>
  );
}
