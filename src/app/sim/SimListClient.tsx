"use client";

import Link from "next/link";
import { useState } from "react";
import LabTabs from "@/components/strategy/LabTabs";
import SimForm from "@/components/strategy/SimForm";
import { money, pct, universeLabel, upDownCls, useList, type Sim, type Strategy } from "@/components/strategy/api";
import { btnPrimary, cardCls } from "@/components/auth/ui";

export default function SimListClient() {
  const sims = useList<Sim>("/api/strategy/sims");
  const strategies = useList<Strategy>("/api/strategy/strategies");
  const [creating, setCreating] = useState(false);
  const stName = (id: string) => strategies.items?.find((s) => s.id === id)?.name ?? (id ? "（策略已刪除）" : "只手動下單");

  return (
    <div className="space-y-5 pb-24">
      <LabTabs active="/sim" intro="模擬倉用虛擬資金依你選的策略自動買賣（每個交易日收盤後執行），也可以手動下單；成交價用收盤價（手動下單用最新報價），手續費與證交稅照實扣。" />
      {(sims.error || strategies.error) && <p className="text-sm text-(--price-up)">{sims.error || strategies.error}</p>}

      {creating ? (
        <SimForm
          strategies={strategies.items ?? []}
          strategiesLoading={strategies.items === null && !strategies.error}
          onCancel={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await sims.reload();
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={btnPrimary} onClick={() => setCreating(true)}>
            ＋ 建立模擬倉
          </button>
          {strategies.items?.length === 0 && (
            <span className="text-sm text-(--text-muted)">
              還沒有策略，可以先到{" "}
              <Link href="/strategies" className="text-(--accent) underline">
                策略庫
              </Link>{" "}
              建立，或建立只手動下單的模擬倉。
            </span>
          )}
        </div>
      )}

      {sims.items === null && !sims.error && <p className="text-sm text-(--text-muted)">載入中…</p>}
      {sims.items?.length === 0 && !creating && <p className="text-sm text-(--text-muted)">還沒有模擬倉。</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {sims.items?.map((s) => (
          <Link key={s.id} href={`/sim/${s.id}`} prefetch={false} className={`${cardCls} block space-y-2 hover:border-(--accent)`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{s.name}</div>
                <div className="text-xs text-(--text-muted)">
                  {stName(s.strategyId)}・{universeLabel(s)}
                </div>
              </div>
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${s.autoTrade ? "border-(--accent) text-(--accent)" : "border-(--gridline) text-(--text-muted)"}`}>
                {s.autoTrade ? "自動交易" : "手動"}
              </span>
            </div>
            <div className="flex items-end justify-between">
              <div>
                <div className="text-xs text-(--text-muted)">總值</div>
                <div className="text-lg font-bold">{money(s.equity)}</div>
              </div>
              <div className={`text-lg font-bold ${upDownCls(s.returnPct)}`}>{pct(s.returnPct)}</div>
            </div>
            <div className="text-xs text-(--text-muted)">
              持有 {s.positions.length} 檔・現金 {money(s.cash)}
              {s.lastRunNote && <span className="block truncate">最近執行：{s.lastRunNote}</span>}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
