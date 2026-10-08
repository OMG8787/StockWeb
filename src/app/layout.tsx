import type { Metadata } from "next";
import "./globals.css";
import SiteHeader from "@/components/SiteHeader";
import ChatWidget from "@/components/ChatWidget";
import PriceAlertWatcher from "@/components/PriceAlertWatcher";
import PageAutoRefresh from "@/components/PageAutoRefresh";
import RequirePerm from "@/components/RequirePerm";
import { PERM } from "@/lib/auth/permissions";
import WatchlistSync from "@/components/WatchlistSync";
import NavigationOverlay from "@/components/NavigationOverlay";
import GlossaryHover from "@/components/GlossaryHover";
import AlertWatcher from "@/components/strategy/AlertWatcher";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { THEME_STORAGE_KEY } from "@/lib/theme";

const TITLE = `${SITE_NAME}｜台股美股即時查詢與 AI 問答`;
const DESCRIPTION = "免費公開的股票研究網站：即時查詢台股與美股報價、互動走勢圖表、篩選排行，並可用 AI 問答快速掌握個股情報。";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: `%s｜${SITE_NAME}` },
  description: DESCRIPTION,
  keywords: ["股票", "台股", "美股", "股價查詢", "K線圖", "技術分析", "AI問答", "StockRadar", "股情雷達"],
  openGraph: {
    type: "website",
    locale: "zh_TW",
    siteName: SITE_NAME,
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: { index: false, follow: false },
};

// Runs before first paint so a dark-mode visitor never sees a light flash.
// Keyed off the shared constant so it can't drift from what ThemeToggle writes.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)});if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  const body = (
    <>
      <SiteHeader />
      <NavigationOverlay />
      <GlossaryHover />
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6">{children}</main>
      <footer className="border-t border-(--gridline) py-6 text-center text-xs text-(--text-muted)">
        <p>本站資訊為公開資料整理與 AI 生成內容，僅供研究參考，不構成投資建議。</p>
        <p className="mt-1">股情雷達 StockRadar · Demo</p>
      </footer>
      <RequirePerm need={[PERM.AI_CHAT]}>
        <ChatWidget />
      </RequirePerm>
      <PriceAlertWatcher />
      {/* 策略即時提醒：有權限的帳號在任何頁面都會背景追蹤（設定在 /strategies/alerts） */}
      <RequirePerm need={[PERM.STRATEGY_LAB]}>
        <AlertWatcher />
      </RequirePerm>
      <PageAutoRefresh />
      {/* 關注清單與庫存一律綁定帳號（未登入時 WatchlistSync 不做事） */}
      <WatchlistSync />
    </>
  );

  return (
    <html lang="zh-Hant" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* A user reported the previous system-font stack (Segoe UI/PingFang
            TC/等) reading as too thin/faint when the site is viewed on a TV
            from across a room — a real, separate problem from plain text
            size (already bumped once in globals.css) or weight (already
            bumped to 500 there too): those system fonts are all fairly
            high-contrast, thin-stroke designs that lose definition at
            distance/on a display's soft anti-aliasing, no matter how large
            or bold they're set. Noto Sans TC is a large, geometric,
            even-stroke-width sans-serif purpose-built for exactly this kind
            of at-a-glance/signage-style legibility, with full Traditional
            Chinese coverage — used here at up to weight 900 (see globals.css)
            for headings/prices specifically because that's where distance
            legibility matters most. Loaded via a plain <link> (not
            next/font/google's self-hosting) because Google's CSS2 endpoint
            already splits a CJK family's huge glyph set into many small
            unicode-range subset files and serves whichever the browser
            actually needs — reimplementing that split reliably through
            next/font's build-time fetch is more fragile for a family this
            large than accepting the one external request. Weight bumped
            further too (see globals.css) — 700 for numbers/prices
            specifically, the content this site's whole point is to convey
            at a glance. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700;900&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-(--page-plane) text-(--text-primary)">
        {body}
      </body>
    </html>
  );
}
