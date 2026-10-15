"use client";

import Link from "next/link";
import { useState } from "react";
import { api, runBusy } from "./api";
import { cardCls } from "@/components/auth/ui";
import { INDICATOR_TYPE_MAP, normalizeParams } from "@/lib/strategy/indicatorCatalog";
import { AI_FULL_TEMPLATE_ID, STRATEGY_TEMPLATES, type StrategyTemplate } from "@/lib/strategy/templates";

/** 「AI 策略・完整版」放在上面的 AI 策略說明區（AiStrategyPanel），範本區不重複列 */
const GALLERY = STRATEGY_TEMPLATES.filter((t) => t.id !== AI_FULL_TEMPLATE_ID);

/**
 * 策略範本（2026-10-15 使用者：「要寫一個指標策略，我之後就可以直接取用，因為也不知道現在 AI 推薦適用什麼策略」）。
 * 每張卡片列出範本的買賣條件與風控，按「一鍵建立」就在自己帳號建好參考指標＋策略（伺服器 templateCreate.ts）。
 */
export function conditionText(t: StrategyTemplate, keys: string[], match: number): string {
  const parts = keys.map((k) => {
    const ind = t.indicators.find((i) => i.key === k)!;
    const type = INDICATOR_TYPE_MAP.get(ind.typeId);
    return type ? type.describe(normalizeParams(ind.typeId, ind.params)) : ind.typeId;
  });
  const how = match <= 0 ? (parts.length > 1 ? "全部符合" : "") : parts.length > 1 ? `至少 ${match} 個符合` : "";
  return `${parts.join("；")}${how ? `（${how}）` : ""}`;
}

export default function TemplateGallery({ onCreated }: { onCreated: (text: string) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  async function create(t: StrategyTemplate) {
    setError("");
    try {
      await runBusy(`依範本建立「${t.name}」中…`, async () => {
        const r = await api<{ name: string; createdIndicators: number }>("/api/strategy/templates", { body: { templateId: t.id } });
        await onCreated(`已建立策略「${r.name}」（新增 ${r.createdIndicators} 個參考指標，其餘沿用你已有的相同指標）。可以按「編輯／測試」調整，或到「⏪ 策略回測」試跑過去 1～3 年。`);
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className={`${cardCls} space-y-3`}>
      <button type="button" className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="font-semibold">📚 策略範本（一鍵建立）</span>
        <span className="shrink-0 text-xs text-(--accent) sm:text-sm">{open ? "收起 ▲" : `展開 ${GALLERY.length} 個範本 ▼`}</span>
      </button>
      {open && (
        <>
          <p className="text-sm text-(--text-muted)">
            常見的起始設定，按「一鍵建立」就會在你的帳號建好需要的參考指標與策略；數值不是驗證過的最佳值，建議先用{" "}
            <Link href="/strategies/backtest" className="text-(--accent) underline">⏪ 策略回測</Link> 跑過去 1～3 年、或開模擬倉比較後再調整。
            想跟 AI 推薦用同一套邏輯，選「AI 推薦風格」兩個範本。
          </p>
          {error && <p className="text-sm text-(--price-up)">{error}</p>}
          <div className="grid gap-3 md:grid-cols-2">
            {GALLERY.map((t) => (
              <div key={t.id} className="flex flex-col gap-2 rounded-md border border-(--gridline) p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{t.name}</span>
                  <span className="rounded bg-(--page-plane) px-1.5 py-0.5 text-[11px] text-(--text-secondary)">{t.style}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] ${t.backtestable ? "bg-(--price-down)/12 text-(--price-down)" : "bg-(--page-plane) text-(--text-muted)"}`}
                    title={t.backtestable ? "只用日K類指標，策略回測能完整重現" : "用到籌碼／基本面／本站評等，沒有逐日歷史，回測時那些條件會當作不成立"}
                  >
                    {t.backtestable ? "可回測" : "回測不完整"}
                  </span>
                </div>
                <p className="text-(--text-secondary)">{t.desc}</p>
                <ul className="space-y-0.5 text-xs text-(--text-secondary)">
                  <li>
                    <b className="text-(--price-up)">買進：</b>
                    {conditionText(t, t.buy.keys, t.buy.match)}
                  </li>
                  <li>
                    <b className="text-(--price-down)">賣出：</b>
                    {conditionText(t, t.sell.keys, t.sell.match)}（任一成立）
                  </li>
                  <li>
                    <b>風控：</b>停損 {t.stopLossPct}%・停利 {t.takeProfitPct}%{t.maxHoldDays ? `・最多持有 ${t.maxHoldDays} 天` : ""}・每檔 {t.positionPct}%・最多 {t.maxPositions} 檔
                  </li>
                </ul>
                <p className="text-xs text-(--text-muted)">⚠️ {t.risk}</p>
                <button type="button" className="mt-auto self-start rounded-md bg-(--accent) px-3 py-1.5 text-sm font-medium text-white" onClick={() => create(t)}>
                  ＋ 一鍵建立
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
