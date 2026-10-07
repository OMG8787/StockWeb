import Link from "next/link";
import { Suspense } from "react";
import MarketTabs from "@/components/MarketTabs";
import MacroCard from "@/components/MacroCard";
import WatchlistSection from "@/components/WatchlistSection";
import DailyBriefCard from "@/components/DailyBriefCard";
import RequirePerm from "@/components/RequirePerm";
import { PERM } from "@/lib/auth/permissions";
import SimPortfolioCard from "@/components/simPortfolio/SimPortfolioCard";
import LiveIndices from "@/components/LiveIndices";
import LiveMoversBoard from "@/components/LiveMoversBoard";
import TaifexFuturesCard from "@/components/TaifexFuturesCard";
import { getIndices, getTaifexNightFutures, isMacroConfigured, searchStocks } from "@/lib/data";

export const revalidate = 0;

// 2026-10-04「各頁 5 秒內完整顯示」：原本整頁 await 指數＋台指期＋台美兩份全市場
// 排行四項全部到齊才送出任何內容（期間只看到 loading.tsx 的骨架），最慢那一項
// （全市場報價表冷快取時）拖住整頁，連不需要資料的標題區、快報、關注清單都出不來。
// 改成大盤指數、焦點排行各自用 Suspense 串流：首屏先出，兩塊資料各自到齊就各自補上。
async function HomeIndices() {
  const [indices, taifexFutures] = await Promise.all([getIndices(), getTaifexNightFutures()]);
  const twIndices = indices.filter((i) => i.market === "TW");
  const usIndices = indices.filter((i) => i.market === "US");
  return (
    <MarketTabs
      tw={
        <div className="space-y-3">
          <LiveIndices market="TW" initialIndices={twIndices} />
          <TaifexFuturesCard initialQuote={taifexFutures} />
        </div>
      }
      us={<LiveIndices market="US" initialIndices={usIndices} />}
    />
  );
}

async function HomeMovers() {
  const [twMovers, usMovers] = await Promise.all([
    searchStocks({ market: "TW", sortBy: "changePercent", sortDir: "desc" }),
    searchStocks({ market: "US", sortBy: "changePercent", sortDir: "desc" }),
  ]);
  return (
    <MarketTabs
      tw={<LiveMoversBoard market="TW" initialItems={twMovers.slice(0, 8)} />}
      us={<LiveMoversBoard market="US" initialItems={usMovers.slice(0, 8)} />}
    />
  );
}

function BlockSkeleton({ height }: { height: string }) {
  return <div className={`${height} animate-pulse rounded-lg border border-(--gridline) bg-(--surface-1)`} aria-hidden />;
}

export default function HomePage() {
  return (
    <div className="space-y-10">
      <section className="rounded-xl border border-(--gridline) bg-(--surface-1) p-6 sm:p-10">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
          用最快的方式看懂台股與美股
        </h1>
        <p className="mt-2 max-w-2xl text-(--text-secondary)">
          即時查詢個股報價、互動走勢圖表，搭配 AI 問答與篩選排行（可用功能依帳號權限而定）。
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href="/stock/2330"
            className="rounded-md bg-(--accent) px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            試試看：台積電 2330
          </Link>
          <Link
            href="/stock/AAPL?market=US"
            className="rounded-md border border-(--gridline) bg-(--surface-2) px-4 py-2 text-sm font-medium hover:bg-(--page-plane)"
          >
            試試看：Apple AAPL
          </Link>
          <Link
            href="/search"
            className="rounded-md border border-(--gridline) bg-(--surface-2) px-4 py-2 text-sm font-medium hover:bg-(--page-plane)"
          >
            前往搜尋 / 篩選
          </Link>
          <Link
            href="/highlights"
            className="rounded-md border border-(--gridline) bg-(--surface-2) px-4 py-2 text-sm font-medium hover:bg-(--page-plane)"
          >
            每日焦點榜單
          </Link>
        </div>
      </section>

      <RequirePerm need={[PERM.ACTION]}>
        <DailyBriefCard />
      </RequirePerm>

      <section>
        <h2 className="mb-3 text-lg font-semibold">大盤指數</h2>
        <Suspense fallback={<BlockSkeleton height="h-44" />}>
          <HomeIndices />
        </Suspense>
        {/* 總經卡片放在分頁外面（台股/美股分頁都看得到），用 Suspense 串流、不擋首屏；
            沒設定 FRED_API_KEY 時整塊不渲染，首頁跟以前一樣。 */}
        {isMacroConfigured() && (
          <Suspense
            fallback={<div className="mt-3 h-40 animate-pulse rounded-lg border border-(--gridline) bg-(--surface-1)" aria-hidden />}
          >
            <MacroCard />
          </Suspense>
        )}
      </section>

      {/* 2026-10-06 使用者：大盤指數移到快報下面、關注名單移到 AI 模擬上面。 */}
      <WatchlistSection />

      <RequirePerm need={[PERM.SIM_PORTFOLIO]}>
        <SimPortfolioCard />
      </RequirePerm>

      <section>
        <div className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-semibold">焦點排行</h2>
            <Link href="/search" className="text-sm text-(--accent) hover:underline">
              查看完整排行 →
            </Link>
          </div>
          <Suspense fallback={<BlockSkeleton height="h-72" />}>
            <HomeMovers />
          </Suspense>
        </div>
      </section>

      <RequirePerm need={[PERM.AI_CHAT]}>
        <section className="rounded-lg border border-(--gridline) bg-(--surface-1) p-6 text-center">
          <h2 className="font-semibold">有問題想問？</h2>
          <p className="mt-1 text-sm text-(--text-secondary)">
            點右下角的 AI 問答，直接用中文問「2330 最近走勢如何？」或「AAPL 現在多少錢？」
          </p>
        </section>
      </RequirePerm>
    </div>
  );
}
