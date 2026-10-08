/**
 * 導覽列項目（純資料）。2026-10-08 使用者要求：滑鼠移到某一列，就能看到它底下的功能頁面（例如「模擬倉」）。
 * children＝這個項目底下的頁面；沒有 children 的項目就是單純的連結。
 * 桌機：滑鼠移上去（或鍵盤 Tab 到）展開選單；手機：目前所在群組的子頁面會多一排顯示在導覽列下面。
 * 每個項目／子頁面都依帳號權限過濾（canSeePath）。
 */

export interface NavChild {
  href: string;
  label: string;
  /** 一句話說明這頁做什麼（選單裡顯示） */
  desc: string;
}

export interface NavItem {
  href: string;
  label: string;
  children?: NavChild[];
  /** 這些路徑底下的頁面也算「目前在這個項目」（預設只有 href 本身、子頁面與其子路徑） */
  alsoActive?: string[];
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "首頁" },
  {
    href: "/action",
    label: "今日建議",
    children: [
      { href: "/action", label: "今日建議", desc: "本站每天挑出的建議買進名單與操作時段" },
      { href: "/scoreboard", label: "成績看板", desc: "歷史評等的實際表現與勝率" },
    ],
  },
  { href: "/highlights", label: "每日焦點" },
  { href: "/portfolio", label: "AI 模擬組合" },
  {
    href: "/sim",
    label: "模擬倉",
    alsoActive: ["/strategies", "/indicators"],
    children: [
      { href: "/sim", label: "📈 模擬倉", desc: "用虛擬資金依策略自動買賣，或手動下單" },
      { href: "/strategies", label: "🧠 策略庫", desc: "建立買賣規則與股票篩選" },
      { href: "/strategies/compare", label: "📊 策略疊圖", desc: "1～10 檔股票疊多個策略看訊號" },
      { href: "/strategies/alerts", label: "🔔 即時提醒", desc: "追蹤名單、定時鬧鐘、買點通知" },
      { href: "/indicators", label: "📐 參考指標", desc: "建立可調參數的判斷條件" },
    ],
  },
  { href: "/news", label: "重大新聞" },
  { href: "/search", label: "搜尋 / 篩選" },
];

/** 目前路徑屬於哪個導覽項目（最長前綴優先；首頁只在完全等於 / 時算） */
export function activeNavHref(pathname: string, items: NavItem[]): string | null {
  let best: { href: string; len: number } | null = null;
  for (const item of items) {
    const prefixes = [item.href, ...(item.alsoActive ?? []), ...(item.children?.map((c) => c.href) ?? [])];
    for (const p of prefixes) {
      const hit = p === "/" ? pathname === "/" : pathname === p || pathname.startsWith(p + "/");
      if (hit && (!best || p.length > best.len)) best = { href: item.href, len: p.length };
    }
  }
  return best?.href ?? null;
}
