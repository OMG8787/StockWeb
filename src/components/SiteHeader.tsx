"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useBriefStance } from "./ActionBriefHeading";
import ThemeToggle from "./ThemeToggle";
import AuthButton from "./AuthButton";

interface SymbolSuggestion {
  symbol: string;
  name: string;
  market: "TW" | "US";
  exchange?: "TWSE" | "TPEx";
}

/** 桌機／手機兩份導覽列原本各自硬寫一次完全一樣的5個項目，只有className不同——
 *  2026-09-22 地毯式審計發現這是「同一份清單兩處各寫一次」的例子，改成共用陣列
 *  搭配.map()渲染，新增/修改一個導覽項目只要改這裡一處，不會漏改其中一個裝置版本。 */
const NAV_ITEMS: Array<{ href: string; label: string }> = [
  { href: "/", label: "首頁" },
  { href: "/action", label: "今日建議" },
  { href: "/highlights", label: "每日焦點" },
  { href: "/news", label: "重大新聞" },
  { href: "/search", label: "搜尋 / 篩選" },
];

/** 使用者看得懂的市場別標籤（內部的 exchange 欄位不直接曝光）。 */
function marketLabel(item: SymbolSuggestion): string {
  if (item.market === "US") return "美股";
  if (item.exchange === "TPEx") return "上櫃";
  return "上市";
}

/**
 * 台股代號（4-6 碼純數字）本來就唯一，不需要列清單讓人再選一次——直接沿用原本
 * 「打完 Enter 就跳轉」的行為，連查詢都不用等，最快也最不會改壞既有體驗。
 * 英文輸入刻意「不」走這條捷徑：像 apple / ford / visa 這種常見公司名長度都在
 * 美股代號的 1-5 碼範圍內，若照格式硬判成代號會直接跳到一個不存在的
 * /stock/APPLE；改成一律先查，再由「結果裡有沒有代號完全相同的那一檔」決定要不要
 * 直接跳轉（見 resolveAndGo），這樣 AAPL、F、T 這類真代號一樣是一次到位。
 */
function isTwStockCode(input: string): boolean {
  return /^\d{4,6}$/.test(input);
}

const SUGGEST_DEBOUNCE_MS = 200;

export default function SiteHeader({ authEnabled }: { authEnabled: boolean }) {
  // 「今日建議」在 14:30 後到隔天開盤前改叫「明日操作建議」（跟 /action 頁首、卡片同一個判斷，見 tradingStance.ts）。
  const briefTitle = useBriefStance().briefTitle;
  const navItems = NAV_ITEMS.map((item) => (item.href === "/action" ? { ...item, label: briefTitle } : item));
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<SymbolSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pending, setPending] = useState(false);
  // 每次「建議清單」查詢帶一個遞增序號，只採用最後一次送出的回應——使用者打字很快
  // 時，先送出的請求可能比後送出的晚回來，沒有這層防護清單會閃回舊關鍵字的結果。
  //
  // **這個序號只管建議清單，絕對不能套用在按 Enter 送出的那次查詢上**：Enter 送出
  // 時 debounce 的計時器往往還沒觸發，隨後才發出的建議查詢會把序號墊高，若 Enter
  // 那次也照序號作廢自己的回應，就會拿到空結果而退化成「導向 /stock/<使用者打的
  // 中文字>」的查無資料頁（實測：打完「欣興」「美利達」立刻按 Enter 100% 重現）。
  const requestSeq = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const [menuWidth, setMenuWidth] = useState<number | undefined>(undefined);

  // 清單寬度用實際量測決定，不用純 CSS 夾制。原因：全站 root font-size 被調成
  // 19px（見工作日誌字級調整），Tailwind 的 w-72 這類 rem 寬度會跟著放大成
  // 342px，手機（390px）上搜尋框本身只有約 138px 寬、右邊界在 x≈306，靠右對齊
  // 的清單就會往左溢出到 x=-35（實測）。改成「清單右緣貼齊輸入框、寬度取
  // min(320px, 輸入框右緣-12px) 但不小於輸入框本身」，左邊界必定留 12px 在畫面
  // 內，而且不管字級、視窗寬度、有沒有登入按鈕佔位都成立。
  useEffect(() => {
    if (!open) return;
    function update() {
      const el = boxRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setMenuWidth(Math.max(rect.width, Math.min(320, rect.right - 12)));
    }
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open]);

  async function lookup(q: string): Promise<SymbolSuggestion[]> {
    const res = await fetch(`/api/symbol-lookup?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`lookup failed: ${res.status}`);
    const data = (await res.json()) as { results?: SymbolSuggestion[] };
    return data.results ?? [];
  }

  // 打字時即時給建議清單（debounce 200ms）。這支端點只做記憶體字典比對、
  // 不抓任何報價，所以每次按鍵都查也不會對上游資料源造成負擔。
  useEffect(() => {
    const trimmed = query.trim();
    // 清空時收起清單改在 onChange 裡直接做（見下方輸入框），不在 effect 裡同步 setState
    //（react-hooks/set-state-in-effect：effect 本體同步 setState 會造成連鎖重繪）。
    if (!trimmed) return;
    const timer = setTimeout(() => {
      const seq = ++requestSeq.current;
      lookup(trimmed)
        .then((results) => {
          // 過期的建議查詢（使用者已經又打了新的字）直接丟掉，避免清單閃回舊關鍵字
          if (seq !== requestSeq.current) return;
          setSuggestions(results);
          setActiveIndex(-1);
          setOpen(results.length > 0);
        })
        .catch(() => {
          // 建議清單查不到就安靜收起來，使用者照樣可以按 Enter 走原本的導頁流程
          if (seq !== requestSeq.current) return;
          setSuggestions([]);
          setOpen(false);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // 點到搜尋框以外的地方就收起清單（手機上點別處也適用）
  useEffect(() => {
    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, []);

  function go(symbol: string) {
    setOpen(false);
    setSuggestions([]);
    setActiveIndex(-1);
    router.push(`/stock/${encodeURIComponent(symbol)}`);
  }

  async function resolveAndGo(trimmed: string) {
    setPending(true);
    try {
      const results = await lookup(trimmed);
      const exact = results.find((r) => r.symbol.toUpperCase() === trimmed.toUpperCase());
      // 代號打完整（含美股 AAPL/F/T）→ 直接跳轉，不多一次點擊打斷使用者
      if (exact) return go(exact.symbol);
      // 剛好只比對到一檔 → 維持「唯一結果直接跳轉」的既有體驗
      if (results.length === 1) return go(results[0].symbol);
      // 比對到多檔 → 列出來讓使用者自己選，不擅自幫他決定是哪一檔
      if (results.length > 1) {
        setSuggestions(results);
        setActiveIndex(-1);
        setOpen(true);
        return;
      }
      // 一檔都比對不到 → 維持原本行為，導到目的頁由它顯示「查無資料」
      go(trimmed);
    } catch {
      // 查詢失敗時退回原本行為，不要讓搜尋框整個卡住不能用
      go(trimmed);
    } finally {
      setPending(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    // 鍵盤上下鍵已經選好某一項時，Enter 就是確認那一項
    if (open && activeIndex >= 0 && suggestions[activeIndex]) {
      go(suggestions[activeIndex].symbol);
      return;
    }
    if (isTwStockCode(trimmed)) {
      go(trimmed);
      return;
    }
    void resolveAndGo(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    }
  }

  return (
    <header className="border-b border-(--gridline) bg-(--surface-1)">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-4">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-(--accent) text-white font-bold text-sm">
            SR
          </span>
          <span className="font-semibold text-lg tracking-tight">股情雷達</span>
        </Link>

        <nav className="hidden sm:flex items-center gap-1 text-sm">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="px-3 py-2 rounded-md text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--page-plane)"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div ref={boxRef} className="relative ml-auto flex-1 max-w-sm">
          <form onSubmit={handleSubmit}>
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!e.target.value.trim()) {
                  // 清空輸入：讓進行中的建議查詢作廢，並立刻收起清單
                  requestSeq.current++;
                  setSuggestions([]);
                  setOpen(false);
                }
              }}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (suggestions.length > 0) setOpen(true);
              }}
              role="combobox"
              aria-expanded={open}
              aria-controls="symbol-suggestions"
              aria-autocomplete="list"
              autoComplete="off"
              placeholder="輸入代碼或名稱，例如 2330 或 台積電"
              className="w-full rounded-md border border-(--gridline) bg-(--surface-2) px-3 py-2 text-sm placeholder:text-(--text-muted) focus:outline-none focus:ring-2 focus:ring-(--accent)"
            />
          </form>
          {(open && suggestions.length > 0) || pending ? (
            <ul
              id="symbol-suggestions"
              role="listbox"
              style={menuWidth ? { width: menuWidth } : undefined}
              className="absolute right-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-md border border-(--gridline) bg-(--surface-1) py-1 shadow-lg"
            >
              {pending && suggestions.length === 0 ? (
                <li className="px-3 py-2 text-sm text-(--text-muted)">搜尋中…</li>
              ) : (
                suggestions.map((item, i) => (
                  <li key={`${item.market}:${item.symbol}`} role="option" aria-selected={i === activeIndex}>
                    <button
                      type="button"
                      // onMouseDown 先擋掉預設行為，避免輸入框失焦導致清單在 click
                      // 真的送出之前就被收起來（那樣會變成「點了沒反應」）。
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => go(item.symbol)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-(--page-plane) ${
                        i === activeIndex ? "bg-(--page-plane)" : ""
                      }`}
                    >
                      <span className="truncate">{item.name}</span>
                      <span className="shrink-0 text-xs text-(--text-secondary)">
                        {item.symbol}・{marketLabel(item)}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
        {authEnabled && <AuthButton />}
        <ThemeToggle />
      </div>
      {/* overflow-x-auto + whitespace-nowrap: 5 nav items no longer fit an
          average phone width on one line without wrapping — an Opus QA pass
          measured every label breaking mid-word ("今日建/議") at every real
          phone width once this went from 3 items to 5. A horizontally
          scrollable row keeps each label intact; there's no visual "more"
          affordance, but the row starting mid-scroll on first-visible items
          is a familiar enough mobile pattern and avoids a bigger layout
          rework for what's still a short list. */}
      <nav className="flex sm:hidden items-center gap-1 overflow-x-auto px-4 pb-2 text-sm">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-(--text-secondary) hover:bg-(--page-plane)"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
