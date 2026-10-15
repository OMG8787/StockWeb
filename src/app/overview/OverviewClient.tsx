"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import WatchlistButton from "@/components/WatchlistButton";
import RecommendationGuide from "@/components/RecommendationGuide";
import { AiListsProvider, useAiLists } from "@/components/AiListsContext";
import { AdviceBadge, WatchAdviceProvider } from "@/components/WatchAdviceContext";
import { ALERT_CHECK_NOW_EVENT } from "@/components/strategy/AlertWatcher";
import { signalText, type AlertItem } from "@/lib/strategy/alertFormat";
import { PERM } from "@/lib/auth/permissions";
import { useHasPerm } from "@/lib/auth/useProfile";
import { useFetchOnce } from "@/lib/useFetchOnce";
import { useTwQuotes } from "@/lib/useTwQuotes";
import { formatPercent, formatPrice, priceDirectionClass } from "@/lib/format";
import { clientRefreshMs } from "@/lib/autoRefresh";
import type { MomentumItem } from "@/lib/data/momentum";
import type { WatchlistItem } from "@/lib/watchlist";
import type { SmartListData } from "@/lib/strategy/smartListCore";

/**
 * 推薦總覽（2026-10-15 使用者：「AI 推薦、排程提醒、技術訊號共振股，我希望可以增加一個統一，一次看本次推薦，不然要一直切來切去很困擾，而且容易看不懂」）。
 *
 * 把四份名單合成一張表，每檔一列、標出它出現在哪些名單：
 *  🎯 AI 建議（帳號設定的前 N 檔，跟「我的關注 → AI 建議清單」同一份）、📡 技術訊號共振股（/api/momentum）、
 *  🔔 提醒訊號（你的即時提醒追蹤名單目前有買進／賣出訊號的；開頁時請全站監看器立即檢查一次）、🤖 AI 持有（AI 模擬組合持股）。
 * 「本站建議」欄跟關注清單的「操作建議」同一個來源（/api/watchlist/advice＝本站綜合評等），一眼看懂要不要買。
 * 沒有權限的名單不抓也不顯示。資料全部來自既有 API，沒有複製任何判斷邏輯。
 */

type SourceKey = "ai" | "momentum" | "smart" | "alert" | "held";

const SOURCE_META: Record<SourceKey, { label: string; badge: string; cls: string; tip: string }> = {
  ai: { label: "AI 建議", badge: "🎯 AI建議", cls: "bg-(--price-up)/15 text-(--price-up)", tip: "本站依綜合評等挑出的建議買進名單（依評分排名，取你設定的前 N 檔）" },
  momentum: { label: "技術訊號共振", badge: "📡 共振", cls: "bg-[#c98a1b]/15 text-[#c98a1b]", tip: "成交活躍、同時出現多個技術訊號的股票（只看技術面，還要搭配本站建議判斷）" },
  alert: { label: "提醒訊號", badge: "🔔 提醒", cls: "bg-(--accent)/15 text-(--accent)", tip: "你在「即時提醒」追蹤的股票，目前有策略出現買進或賣出訊號" },
  smart: { label: "智能清單", badge: "🧠 智能清單", cls: "bg-[#8a63d2]/15 text-[#8a63d2]", tip: "你的智能清單裡目前符合策略的股票（依你選的策略每天掃描全市場）" },
  held: { label: "AI 持有", badge: "🤖 AI持有", cls: "bg-(--page-plane) text-(--text-secondary)", tip: "AI 模擬投資組合目前持有這檔" },
};

interface Row {
  symbol: string;
  name: string;
  sources: Set<SourceKey>;
  aiRank?: number;
  aiLabel?: string;
  aiPlan?: string;
  aiConfidence?: string;
  momentumRank?: number;
  signals?: string[];
  alertLines?: string[];
  smartStrategies?: string[];
  alertTone?: "buy" | "sell";
  heldPnl?: number;
}

export default function OverviewClient() {
  return (
    <AiListsProvider>
      <Overview />
    </AiListsProvider>
  );
}

function Overview() {
  const ai = useAiLists();
  const canLab = useHasPerm([PERM.STRATEGY_LAB]);
  const momentum = useFetchOnce<{ items: MomentumItem[] }>("/api/momentum?market=TW", clientRefreshMs);
  const smart = useFetchOnce<{ data: SmartListData }>(canLab ? "/api/strategy/smart-list" : null, clientRefreshMs);
  const [alerts, setAlerts] = useState<AlertItem[] | null>(null);
  const [alertNote, setAlertNote] = useState(canLab ? "檢查提醒訊號中…" : "");
  const [filter, setFilter] = useState<SourceKey | "multi" | "all">("all");

  // 提醒訊號：請全站的提醒監看器立即用你的設定檢查一次（同一套比對；沒設定追蹤名單會回 null）
  useEffect(() => {
    if (!canLab) return;
    const onChecked = (e: Event) => {
      const d = (e as CustomEvent<{ items: AlertItem[] } | null>).detail;
      if (!d) {
        setAlerts([]);
        setAlertNote("還沒設定即時提醒的追蹤名單（到「模擬倉 → 即時提醒」設定）");
        return;
      }
      setAlerts(d.items);
      setAlertNote("");
    };
    window.addEventListener("stockradar:alert-checked", onChecked);
    const t = setTimeout(() => window.dispatchEvent(new Event(ALERT_CHECK_NOW_EVENT)), 300);
    return () => {
      clearTimeout(t);
      window.removeEventListener("stockradar:alert-checked", onChecked);
    };
  }, [canLab]);

  const rows = useMemo(() => {
    const map = new Map<string, Row>();
    const get = (symbol: string, name: string) => {
      const k = symbol.toUpperCase();
      let r = map.get(k);
      if (!r) map.set(k, (r = { symbol: k, name, sources: new Set() }));
      return r;
    };
    (ai.picks ?? []).forEach((p, i) => {
      const r = get(p.symbol, p.name);
      r.sources.add("ai");
      r.aiRank = i + 1;
      r.aiLabel = p.label;
      r.aiPlan = p.plan;
      r.aiConfidence = p.confidence;
    });
    (momentum.data?.items ?? []).forEach((m, i) => {
      const r = get(m.symbol, m.name);
      r.sources.add("momentum");
      r.momentumRank = i + 1;
      r.signals = m.signals.map((s) => s.label);
    });
    for (const it of alerts ?? []) {
      const sig = it.lines.filter((l) => l.current === "buy" || l.current === "sell");
      if (sig.length === 0) continue;
      const r = get(it.symbol, it.name);
      r.sources.add("alert");
      r.alertLines = sig.map((l) => `${l.name}：${signalText(l)}`);
      r.alertTone = sig.some((l) => l.current === "buy") ? "buy" : "sell";
    }
    for (const h of ai.holdings ?? []) {
      const r = get(h.symbol, h.name);
      r.sources.add("held");
      r.heldPnl = h.pnlPct;
    }
    for (const e of smart.data?.data.entries ?? []) {
      if (!e.qualified) continue;
      const r = get(e.symbol, e.name);
      r.sources.add("smart");
      r.smartStrategies = e.strategies;
    }
    return [...map.values()].sort(
      (a, b) =>
        b.sources.size - a.sources.size ||
        (a.aiRank ?? 99) - (b.aiRank ?? 99) ||
        (a.momentumRank ?? 99) - (b.momentumRank ?? 99) ||
        a.symbol.localeCompare(b.symbol),
    );
  }, [ai.picks, ai.holdings, momentum.data, alerts, smart.data]);

  const shown = rows.filter((r) => (filter === "all" ? true : filter === "multi" ? r.sources.size >= 2 : r.sources.has(filter)));
  const symbols = rows.map((r) => r.symbol).slice(0, 100);
  const quotes = useTwQuotes(symbols);
  const adviceList: WatchlistItem[] = useMemo(() => rows.slice(0, 60).map((r) => ({ symbol: r.symbol, market: "TW", name: r.name })), [rows]); // 操作建議 API 一次最多 60 檔（依排序取前面的）
  const count = (k: SourceKey) => rows.filter((r) => r.sources.has(k)).length;
  const loading = (ai.canPicks && ai.picks === null && !ai.picksFailed) || (!momentum.data && !momentum.failed);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">🧭 推薦總覽</h1>
        <p className="mt-1 text-sm text-(--text-secondary)">
          一次看本站所有推薦來源：每檔股票一列，標出它出現在哪些名單；「本站建議」欄是本站綜合評等的結論（跟個股頁、關注清單同一個），滑鼠移上去有說明。
          出現在越多名單的排越前面。
        </p>
      </div>

      <RecommendationGuide variant="full" />

      <div className="flex flex-wrap gap-2 text-sm">
        <Chip active={filter === "all"} onClick={() => setFilter("all")} label={`全部（${rows.length}）`} />
        <Chip active={filter === "multi"} onClick={() => setFilter("multi")} label={`⭐ 多個名單重疊（${rows.filter((r) => r.sources.size >= 2).length}）`} tip="同時出現在兩份以上名單的股票" />
        {(Object.keys(SOURCE_META) as SourceKey[])
          .filter((k) => (k === "ai" ? ai.canPicks : k === "held" ? ai.canHoldings : k === "alert" || k === "smart" ? canLab : true))
          .map((k) => (
            <Chip key={k} active={filter === k} onClick={() => setFilter(k)} label={`${SOURCE_META[k].badge}（${count(k)}）`} tip={SOURCE_META[k].tip} />
          ))}
      </div>
      {alertNote && <p className="text-xs text-(--text-muted)">🔔 {alertNote}</p>}

      {loading && rows.length === 0 ? (
        <div className="h-40 animate-pulse rounded-lg bg-(--page-plane)" />
      ) : shown.length === 0 ? (
        <p className="rounded-lg border border-(--gridline) bg-(--surface-1) p-5 text-sm text-(--text-muted)">這個分類目前沒有股票。</p>
      ) : (
        <WatchAdviceProvider list={adviceList}>
          {/* 手機：卡片（不用左右滑）；平板以上：表格 */}
          <ul className="space-y-2 sm:hidden">
            {shown.map((r) => {
              const q = quotes[r.symbol];
              return (
                <li key={r.symbol} className="rounded-lg border border-(--gridline) bg-(--surface-1) p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-1.5">
                      <WatchlistButton symbol={r.symbol} market="TW" name={r.name} />
                      <Link href={`/stock/${r.symbol}?market=TW`} prefetch={false} className="min-w-0 font-medium hover:text-(--accent)">
                        {r.name} <span className="text-xs font-normal text-(--text-muted)">{r.symbol}</span>
                      </Link>
                    </div>
                    <div className="shrink-0 text-right text-sm tabular-nums">
                      <div>{q ? formatPrice(q.price, "TWD") : "—"}</div>
                      <div className={`text-xs ${q ? priceDirectionClass(q.changePercent) : "text-(--text-muted)"}`}>{q ? formatPercent(q.changePercent) : "—"}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-(--text-muted)">本站建議</span>
                    <AdviceBadge market="TW" symbol={r.symbol} />
                    <SourceBadges r={r} />
                  </div>
                  <div className="mt-1.5 text-xs leading-relaxed text-(--text-secondary)">
                    <RowNotes r={r} />
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="hidden overflow-x-auto rounded-lg border border-(--gridline) bg-(--surface-1) sm:block">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="border-b border-(--gridline)">
                <tr className="text-left text-xs text-(--text-muted)">
                  <th className="px-2 py-2" aria-label="加入關注" />
                  <th className="px-2 py-2 font-medium">股票</th>
                  <th className="px-2 py-2 text-right font-medium">現價</th>
                  <th className="px-2 py-2 text-right font-medium">漲跌幅</th>
                  <th className="px-2 py-2 font-medium" title="本站綜合評等的結論：買／不買（還沒持有的角度），* 表示需觀察；滑鼠移到標籤上看理由">
                    本站建議
                  </th>
                  <th className="px-2 py-2 font-medium" title="這檔出現在哪些名單">出現在</th>
                  <th className="px-2 py-2 font-medium">重點</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const q = quotes[r.symbol];
                  return (
                    <tr key={r.symbol} className="border-b border-(--gridline) align-top last:border-0 hover:bg-(--page-plane)">
                      <td className="py-2 pl-2">
                        <WatchlistButton symbol={r.symbol} market="TW" name={r.name} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        <Link href={`/stock/${r.symbol}?market=TW`} prefetch={false} className="font-medium hover:text-(--accent)">
                          {r.name}
                        </Link>
                        <span className="block text-xs text-(--text-muted)">{r.symbol}</span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{q ? formatPrice(q.price, "TWD") : "—"}</td>
                      <td className={`whitespace-nowrap px-2 py-2 text-right tabular-nums ${q ? priceDirectionClass(q.changePercent) : "text-(--text-muted)"}`}>
                        {q ? formatPercent(q.changePercent) : "—"}
                      </td>
                      <td className="px-2 py-2">
                        <AdviceBadge market="TW" symbol={r.symbol} />
                      </td>
                      <td className="px-2 py-2">
                        <SourceBadges r={r} />
                      </td>
                      <td className="max-w-[360px] px-2 py-2 text-xs leading-relaxed text-(--text-secondary)">
                        <RowNotes r={r} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </WatchAdviceProvider>
      )}

      <p className="text-xs text-(--text-muted)">
        想知道這些推薦過去準不準？看 <Link href="/review" className="text-(--accent) underline">📈 推薦回顧</Link>（每次推薦的價格與照建議操作的結果）。
        AI 建議名單的檔數可以在首頁「我的關注 → AI 建議清單」調整。僅供參考，不構成投資建議。
      </p>
    </div>
  );
}

function SourceBadges({ r }: { r: Row }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {(Object.keys(SOURCE_META) as SourceKey[])
        .filter((k) => r.sources.has(k))
        .map((k) => (
          <span key={k} title={SOURCE_META[k].tip} className={`cursor-help whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${SOURCE_META[k].cls}`}>
            {SOURCE_META[k].badge}
            {k === "ai" && r.aiRank ? ` #${r.aiRank}` : ""}
            {k === "momentum" && r.momentumRank ? ` #${r.momentumRank}` : ""}
            {k === "alert" ? (r.alertTone === "buy" ? " 買" : " 賣") : ""}
          </span>
        ))}
    </span>
  );
}

function RowNotes({ r }: { r: Row }) {
  return (
    <>
      {r.aiLabel && <span className="block font-medium text-(--text-primary)">{r.aiLabel}</span>}
      {r.aiPlan && <span className="block">操作：{r.aiPlan}</span>}
      {r.aiConfidence && <span className="block text-(--text-muted)">{r.aiConfidence}</span>}
      {r.signals?.length ? <span className="block">技術訊號：{r.signals.join("、")}</span> : null}
      {r.alertLines?.map((l) => (
        <span key={l} className="block">
          🔔 {l}
        </span>
      ))}
      {r.smartStrategies?.length ? <span className="block">🧠 智能清單符合：{r.smartStrategies.join("、")}</span> : null}
      {r.heldPnl != null && <span className="block">AI 模擬組合持有中，未實現損益 {formatPercent(r.heldPnl)}</span>}
    </>
  );
}

function Chip({ active, onClick, label, tip }: { active: boolean; onClick: () => void; label: string; tip?: string }) {
  return (
    <button
      type="button"
      title={tip}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 ${active ? "border-(--accent) bg-(--accent)/10 font-semibold text-(--accent)" : "border-(--gridline) text-(--text-secondary) hover:bg-(--page-plane)"}`}
    >
      {label}
    </button>
  );
}
