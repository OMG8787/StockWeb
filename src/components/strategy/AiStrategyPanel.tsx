"use client";

import Link from "next/link";
import { useState } from "react";
import { api, runBusy } from "./api";
import { cardCls } from "@/components/auth/ui";
import { conditionText } from "./TemplateGallery";
import { PE_CHEAP, PE_EXPENSIVE, QUALIFY_MAX_AGAINST, QUALIFY_MIN_SUPPORT, YIELD_GOOD } from "@/lib/ai/actionScoring";
import { CONFIDENCE_HIGH_MIN_STREAK, CONFIDENCE_LOW_MAX_STREAK, WEAK_MARKET_RET60_PCT } from "@/lib/ai/siteRating";
import { NEAR_ZONE_PCT } from "@/lib/ai/grounding/priceLevels";
import { AI_LIST_MAX, PICK_GROUP_LIMIT } from "@/lib/ai/actionPicks";
import { POOL_CANDIDATE_LIMIT, POOL_RATED_LIMIT, POOL_SOURCES } from "@/lib/ai/actionPoolInfo";
import { AI_FULL_TEMPLATE_ID, TEMPLATE_MAP } from "@/lib/strategy/templates";

/**
 * 「🤖 AI 策略」說明區（2026-10-15 使用者：「增加策略庫的功能，AI 策略，把 AI 的策略都顯示，然後可以自己加減，這樣就可以真正優化策略成為自己的」）。
 *
 * 顯示本站綜合評等（今日建議、AI 建議名單、AI 模擬組合、AI 問答、個股頁共用的同一套）的完整規則——數字全部讀程式裡的同一份常數，
 * 改規則時這裡會自動跟著變；下方列出拆成策略條件的樣子，按「複製成我的策略」就在帳號建立同樣的條件式策略（templates.ts 的 ai-full），
 * 之後在策略列表按「編輯／測試」自由加減條件。
 */
export default function AiStrategyPanel({ onCreated }: { onCreated: (text: string) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const t = TEMPLATE_MAP.get(AI_FULL_TEMPLATE_ID)!;

  async function copy() {
    setError("");
    try {
      await runBusy("建立「AI 策略・完整版」中…", async () => {
        const r = await api<{ name: string; createdIndicators: number }>("/api/strategy/templates", { body: { templateId: t.id } });
        await onCreated(
          `已建立策略「${r.name}」（新增 ${r.createdIndicators} 個參考指標）。在下方策略列表按「編輯／測試」就能自行加減條件，例如拿掉籌碼面要求、加上 RSI 或成交量條件，再用模擬倉比較成績。`,
        );
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className={`${cardCls} space-y-3`}>
      <button type="button" className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="font-semibold">🤖 AI 策略（本站怎麼判斷買不買，可複製成自己的策略）</span>
        <span className="shrink-0 text-xs text-(--accent) sm:text-sm">{open ? "收起 ▲" : "展開看完整規則 ▼"}</span>
      </button>
      {open && (
        <div className="space-y-3 text-sm leading-relaxed text-(--text-secondary)">
          <p>
            今日建議、AI 建議名單、AI 模擬組合、AI 問答、個股頁的「本站綜合評等」都是同一套規則（程式計算，AI 只負責解說）。下面是完整內容；
            按最下面的「複製成我的策略」會在你的帳號建立一模一樣的條件式策略，之後可以自己加減條件。
          </p>

          <Block title="① 五個計分面向（每個面向程式判斷：支持／中性／不支持）">
            <li>技術面：均線、KD、MACD、RSI、布林、成交量等訊號，多方訊號至少 2 個且沒有空方訊號＝支持；空方多於多方＝不支持。</li>
            <li>籌碼面：近幾日三大法人合計買超＝支持、賣超＝不支持。</li>
            <li>持股結構面：大戶持股、外資持股、融資使用率三項裡 2 項偏多且沒有偏空＝支持；2 項偏空＝不支持。</li>
            <li>
              估值面：本益比 ≤ {PE_CHEAP} 倍或殖利率 ≥ {YIELD_GOOD}%＝支持；本益比 &gt; {PE_EXPENSIVE} 倍＝不支持。
            </li>
            <li>財報面：最新月營收年增率為正＝支持；年增率或每股盈餘為負＝不支持。</li>
            <li>消息面：重大訊息與新聞只供參考，不計分。</li>
          </Block>

          <Block title="② 買進門檻（結論＝「建議買進」，其餘一律「建議先不要買」）">
            <li>
              支持的面向至少 {QUALIFY_MIN_SUPPORT} 個、不支持最多 {QUALIFY_MAX_AGAINST} 個。
            </li>
            <li>技術面不能是「不支持」（一票否決；擴大回測唯一穩健的負向訊號）。</li>
            <li>籌碼面不能是「不支持」（三大法人賣超不列為買進）。</li>
            <li>價位框架未破底：現價下方還有支撐（沒有跌破所有均線與近期低點）。</li>
            <li>結論改變要連續 2 個交易日確認才生效（破底立即生效），避免一天買一天賣。</li>
          </Block>

          <Block title="③ 買點與出場價">
            <li>支撐區（買點區間）由均線與近期低點組成；出場價＝支撐下方（買進後收盤跌破就出場）。</li>
            <li>
              現價高於支撐區上緣 {Math.round(NEAR_ZONE_PCT * 1000) / 10}% 以上、或有超買／急漲等漲多警訊時，結論仍是建議買進，但會附「拉回到支撐區上緣可加碼」與短線風險提示，建議分批。
            </li>
          </Block>

          <Block title="④ 把握程度與名單排序">
            <li>
              把握程度：高＝大盤不偏弱且已連續 {CONFIDENCE_HIGH_MIN_STREAK} 個交易日以上建議買進；低＝大盤偏弱且剛轉為建議買進（{CONFIDENCE_LOW_MAX_STREAK} 天內）；其餘為中。
            </li>
            <li>
              大盤偏弱（加權指數近 60 個交易日報酬低於 {WEAK_MARKET_RET60_PCT}%）只附提示、不改結論。
            </li>
            <li>
              AI 建議名單：依把握程度（高→低）、支持面向數、不支持面向數、離支撐遠近排序，最多 {AI_LIST_MAX} 檔（你在「我的關注 → AI 建議清單」設定看前幾檔）；今日建議文字寫前 {PICK_GROUP_LIMIT} 檔。
            </li>
          </Block>

          <Block title="⑤ 名單的候選股從哪來">
            <li>
              不是全市場逐檔評分：先從{POOL_SOURCES.map((s) => s.label).join("、")}各取前幾名組成候選池（最多 {POOL_CANDIDATE_LIMIT} 檔），初篩後最多 {POOL_RATED_LIMIT} 檔算本站評等，只留建議買進的。
            </li>
          </Block>

          <Block title="⑥ 持有中怎麼處理">
            <li>破底＝建議出場；不支持的面向達 2 個以上＝建議減碼；仍是建議買進＝可分批加碼（現價偏高時續抱、拉回再加碼）；其餘續抱、不加碼。</li>
            <li>
              AI 模擬組合就是照這套規則自動買賣（規則與成績見 <Link href="/portfolio" className="text-(--accent) underline">AI 模擬組合</Link>）。
            </li>
          </Block>

          <div className="rounded-md border border-(--gridline) p-3">
            <div className="font-medium text-(--text-primary)">拆成策略條件（複製後可自行加減）</div>
            <ul className="mt-1 space-y-0.5 text-xs">
              <li>
                <b className="text-(--price-up)">買進（全部符合）：</b>
                {conditionText(t, t.buy.keys, t.buy.match)}
              </li>
              <li>
                <b className="text-(--price-down)">賣出（任一成立）：</b>
                {conditionText(t, t.sell.keys, t.sell.match)}
              </li>
              <li>
                <b>風控：</b>停損 {t.stopLossPct}%（近似本站出場價）・每檔 {t.positionPct}%・最多 {t.maxPositions} 檔（同 AI 模擬組合）
              </li>
            </ul>
            <p className="mt-1 text-xs text-(--text-muted)">⚠️ {t.risk}</p>
            {error && <p className="mt-1 text-xs text-(--price-up)">{error}</p>}
            <button type="button" className="mt-2 rounded-md bg-(--accent) px-3 py-1.5 text-sm font-medium text-white" onClick={copy}>
              ＋ 複製成我的策略
            </button>
          </div>

          <p className="text-xs text-(--text-muted)">
            實際成績：<Link href="/scoreboard" className="text-(--accent) underline">成績看板</Link>（每天的評等事後表現）、
            <Link href="/review" className="text-(--accent) underline">推薦回顧</Link>（每次推薦照建議操作的結果）。
          </p>
        </div>
      )}
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-medium text-(--text-primary)">{title}</div>
      <ul className="mt-1 list-inside list-disc space-y-0.5">{children}</ul>
    </div>
  );
}
