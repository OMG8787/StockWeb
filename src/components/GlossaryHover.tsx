"use client";

import { useEffect, useRef, useState } from "react";
import { findTerms, hasTerm, type GlossaryEntry } from "@/lib/glossary";

/**
 * 全站名詞說明：滑鼠移到專有名詞上停一下就顯示說明（手機點一下）。
 * 掛在 layout 一次，整站（含 AI 回答、動態載入的內容）都適用，不用每個頁面各自包元件；
 * 名詞清單與說明只有 lib/glossary.ts 一份。
 *
 * 作法：
 * - 偵測：用瀏覽器的 caretPositionFromPoint 找出游標底下的文字節點與位置，再比對這段文字裡的名詞，
 *   並確認游標真的落在名詞的文字範圍內（不是附近的空白）。
 * - 提示：頁面上有名詞的文字用 CSS Custom Highlight API 畫虛線底線（不改動 DOM、不影響版面與其他元件）；
 *   瀏覽器不支援時沒有底線，但滑過去一樣有說明。
 * - 略過：輸入框、表格資料格、程式碼、已經有 title 的元素（避免兩個提示重疊）、標了 data-no-gloss 的區塊。
 */

const EXCLUDE = "script,style,noscript,textarea,input,select,option,td,code,pre,[title],[data-no-gloss],[contenteditable='true']";
const DWELL_MS = 250;
const SCAN_DEBOUNCE_MS = 600;
const MAX_RANGES = 1500;
const HIGHLIGHT_NAME = "gloss-term";
// ::highlight() 偽元素建置工具的 CSS 解析器還不認得（會報警告），所以執行時才注入樣式
const HIGHLIGHT_CSS = `::highlight(${HIGHLIGHT_NAME}){text-decoration:underline dotted;text-decoration-color:var(--text-muted,#888);text-underline-offset:3px}`;

interface Hit {
  entry: GlossaryEntry;
  rect: DOMRect;
}

function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

/** 游標底下是不是某個名詞（含游標真的落在該文字範圍內的檢查） */
function termAt(x: number, y: number): Hit | null {
  const pos = caretFromPoint(x, y);
  if (!pos || pos.node.nodeType !== Node.TEXT_NODE) return null;
  const node = pos.node as Text;
  const parent = node.parentElement;
  if (!parent || parent.closest(EXCLUDE)) return null;
  for (const h of findTerms(node.data)) {
    if (pos.offset < h.start || pos.offset > h.end) continue;
    const r = document.createRange();
    r.setStart(node, h.start);
    r.setEnd(node, h.end);
    const rect = [...r.getClientRects()].find((c) => x >= c.left - 1 && x <= c.right + 1 && y >= c.top - 1 && y <= c.bottom + 1);
    if (rect) return { entry: h.entry, rect };
  }
  return null;
}

type HighlightApi = { highlights?: Map<string, unknown> };
type HighlightCtor = new (...ranges: Range[]) => unknown;

/** 掃整頁文字，把有名詞的範圍登記成 CSS highlight（畫底線用） */
function scanHighlights() {
  const api = (typeof CSS !== "undefined" ? (CSS as unknown as HighlightApi) : null)?.highlights;
  const Ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  if (!api || !Ctor) return;
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && ranges.length < MAX_RANGES; n = walker.nextNode()) {
    const t = n as Text;
    if (t.data.length < 2 || !hasTerm(t.data)) continue;
    if (t.parentElement?.closest(EXCLUDE)) continue;
    for (const h of findTerms(t.data)) {
      const r = document.createRange();
      r.setStart(t, h.start);
      r.setEnd(t, h.end);
      ranges.push(r);
    }
  }
  api.set(HIGHLIGHT_NAME, new Ctor(...ranges));
}

export default function GlossaryHover() {
  const [tip, setTip] = useState<{ entry: GlossaryEntry; rect: DOMRect } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let dwell: ReturnType<typeof setTimeout> | null = null;
    let pending: Hit | null = null;
    let raf = 0;
    let lastX = 0;
    let lastY = 0;

    const hide = () => {
      if (dwell) clearTimeout(dwell);
      dwell = null;
      pending = null;
      setTip(null);
      setPos(null);
    };

    function onMove(e: PointerEvent) {
      if (e.pointerType !== "mouse") return;
      lastX = e.clientX;
      lastY = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const hit = termAt(lastX, lastY);
        if (!hit) return hide();
        if (pending?.entry === hit.entry && Math.abs(pending.rect.left - hit.rect.left) < 2 && Math.abs(pending.rect.top - hit.rect.top) < 2) return;
        if (dwell) clearTimeout(dwell);
        pending = hit;
        setTip(null);
        dwell = setTimeout(() => setTip(hit), DWELL_MS);
      });
    }

    // 手機：點一下名詞顯示說明（點在連結或按鈕上時不攔截，照原本的功能走）；再點別處收起
    function onTap(e: PointerEvent) {
      if (e.pointerType === "mouse") return;
      const target = e.target as Element | null;
      if (target?.closest("a,button,[role='button'],label,summary")) return hide();
      const hit = termAt(e.clientX, e.clientY);
      if (hit) {
        pending = hit;
        setTip(hit);
      } else hide();
    }

    const style = document.createElement("style");
    style.textContent = HIGHLIGHT_CSS;
    document.head.appendChild(style);

    const timers: { scan: ReturnType<typeof setTimeout> | null } = { scan: null };
    const scheduleScan = () => {
      if (timers.scan) clearTimeout(timers.scan);
      timers.scan = setTimeout(() => {
        const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
        if (ric) ric(scanHighlights);
        else scanHighlights();
      }, SCAN_DEBOUNCE_MS);
    };
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleScan();

    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerup", onTap, { passive: true });
    document.addEventListener("pointerdown", (e) => e.pointerType === "mouse" && hide(), { passive: true });
    document.addEventListener("scroll", hide, { passive: true, capture: true });
    document.addEventListener("keydown", hide, { passive: true });
    document.documentElement.addEventListener("pointerleave", hide);
    return () => {
      observer.disconnect();
      style.remove();
      if (timers.scan) clearTimeout(timers.scan);
      if (dwell) clearTimeout(dwell);
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onTap);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("keydown", hide);
      document.documentElement.removeEventListener("pointerleave", hide);
      (CSS as unknown as HighlightApi).highlights?.delete(HIGHLIGHT_NAME);
    };
  }, []);

  // 提示框位置：預設在名詞下方，下方放不下就放上方；左右夾在畫面內
  useEffect(() => {
    if (!tip || !tipRef.current) return;
    const w = tipRef.current.offsetWidth;
    const h = tipRef.current.offsetHeight;
    const left = Math.min(Math.max(8, tip.rect.left + tip.rect.width / 2 - w / 2), window.innerWidth - w - 8);
    const below = tip.rect.bottom + 8;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, tip.rect.top - h - 8) : below;
    setPos({ left, top });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={tipRef}
      role="tooltip"
      data-no-gloss
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      className="pointer-events-none fixed z-[80] w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-(--gridline) bg-(--surface-1) px-3 py-2 text-xs leading-relaxed shadow-xl"
    >
      <div className="mb-0.5 text-sm font-semibold">{tip.entry.term}</div>
      <div className="text-(--text-secondary)">{tip.entry.text}</div>
    </div>
  );
}
