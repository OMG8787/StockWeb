"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ASK_ABOUT_EVENT, type AskAboutDetail } from "@/lib/chatEvents";
import { getWatchlist, WATCHLIST_CHANGED_EVENT } from "@/lib/watchlist";
import { useVoiceInput } from "@/lib/useVoiceInput";
import MarkdownLite from "./MarkdownLite";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

// 2026-09-23 Opus地毯式巡檢抓到的真實bug：畫面渲染時直接呼叫getWatchlist()
// （不是透過useSyncExternalStore），SSR當下localStorage不存在、getWatchlist()
// 回傳[]，client端hydration時卻讀到真正的清單內容，兩次渲染結果不一致，只要
// 關注清單非空，**每一頁**都會噴React hydration錯誤（#418）——因為ChatWidget
// 掛在root layout、面板用hidden切換而非卸載，這個錯誤不限於AI問答面板本身
// 打開的時候。改用WatchlistSection.tsx/WatchlistTable.tsx已經在用的同一套
// useSyncExternalStore模式：伺服器端快照固定回傳EMPTY，跟client端訂閱
// WATCHLIST_CHANGED_EVENT保持同步，就不會有SSR/CSR不一致的問題。
const EMPTY_WATCHLIST: ReturnType<typeof getWatchlist> = [];

function subscribeToWatchlist(callback: () => void) {
  window.addEventListener(WATCHLIST_CHANGED_EVENT, callback);
  return () => window.removeEventListener(WATCHLIST_CHANGED_EVENT, callback);
}

const SUGGESTIONS = ["2330 最近走勢如何？", "AAPL 現在多少錢？", "今天大盤表現如何？"];

// 輸入框改成可增高的 textarea 後，最多讓它長到這個高度（約 5 行文字），超過就內部捲動，
// 避免把整個聊天面板（有 max-h-[calc(100vh-6rem)] 的尺寸限制）撐爆版面。
const CHAT_TEXTAREA_MAX_HEIGHT_PX = 112;

export default function ChatWidget() {
  const watchlist = useSyncExternalStore(subscribeToWatchlist, getWatchlist, () => EMPTY_WATCHLIST);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [contextSymbol, setContextSymbol] = useState<AskAboutDetail | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 指向「目前這一輪對話裡，使用者剛送出的那則問題」的DOM節點——見下面那個
  // scroll useEffect：問完問題後要把畫面捲到「使用者的問題在最上面」，不是
  // 捲到最下面，讓人可以直接往下看AI的完整回答，不用先看到答案最後一段。
  const lastUserMessageRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { listening, voiceError, toggleVoiceInput, clearVoiceError } = useVoiceInput({ input, setInput, active: open });

  useEffect(() => {
    function handleAskAbout(e: Event) {
      const detail = (e as CustomEvent<AskAboutDetail>).detail;
      setContextSymbol(detail);
      setOpen(true);
      setInput(`關於 ${detail.name}（${detail.symbol}），最近走勢如何？`);
    }
    window.addEventListener(ASK_ABOUT_EVENT, handleAskAbout);
    return () => window.removeEventListener(ASK_ABOUT_EVENT, handleAskAbout);
  }, []);

  // 使用者反映：問完問題、AI回覆出現時，畫面會自動捲到最下面（等於先看到答案的
  // 結尾），應該要捲到「使用者剛剛問的那句話」在最上面，方便從頭往下讀完整答案。
  //
  // 故意在兩個時機都呼叫（不是只呼叫一次）：①送出問題當下（此時答案還沒回來，
  // 讓使用者不用乾等，馬上看到自己的問題被捲上去）；②loading 結束、答案已經
  // 接在問題後面渲染出來的那一刻。只呼叫①的話，實測會卡在一個尷尬的中間位置——
  // ①發生時對話內容還很短（答案還沒出現），瀏覽器把問題捲到最上面時已經頂到
  // 「目前可捲動範圍」的上限，等答案接著長出來、可捲動範圍變大了，捲動位置卻
  // 不會自動跟著往下修正，問題就懸在畫面中間而不是最上緣。②再呼叫一次
  // scrollIntoView，這時答案的完整高度都已經算進可捲動範圍，才能真正把問題
  // 貼齊到最上面。ref 指向「目前這串訊息裡最後一則使用者訊息」，不論當下最後一則
  // 是使用者本人的問題、還是緊接著的AI回答，都會是同一個節點，兩次呼叫互不衝突。
  useEffect(() => {
    lastUserMessageRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [messages, loading]);

  // 輸入框改成 textarea 後要隨內容自動增高，設上限高度、超過就內部捲動。這個 effect
  // 涵蓋所有讓 `input` state 改變的路徑——不只是使用者自己打字（onChange 也會觸發，
  // 但這裡統一處理即可），還包括語音辨識填入文字、「問AI關於」預填問句、送出後清空——
  // 這些都是用 setInput() 直接改 state，不會經過 textarea 自己的 onChange，如果只在
  // onChange 裡調整高度，這些情境就會被漏掉、長文字被裁切看不到。
  // 2026-09-23 Opus地毯式巡檢抓到：面板第一次打開時輸入框會被壓扁成21px、
  // placeholder文字被裁切，要等使用者打字才會自動修正回42px。根因是這個effect
  // 原本只依賴[input]——面板用hidden class切換顯示/隱藏（不是卸載/重新掛載，
  // 見上面關閉/打開保留捲動位置那段說明），面板還是hidden狀態時量到的
  // scrollHeight是0，打開面板本身（open從false變true）不會觸發這個effect
  // 重新量測，所以停留在錯誤的0px直到下一次input改變。補上open依賴，面板
  // 打開的那一刻（DOM的hidden class已經移除、有真正的版面可以量測）就會
  // 重新算一次正確高度。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, CHAT_TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [input, open]);

  // holdings 預設一律讀當下的關注清單，不用每個呼叫端自己記得傳——之前只有
  // 「分析我的關注清單」按鈕會傳，一般用打字問的問題（例如「有沒有虧損的股票
  // 該停損？」）完全沒帶這份資料，導致 AI 只能照實回答「沒有讀取持股的權限」，
  // 讓使用者誤以為這是系統做不到的事，其實只是那次請求沒帶資料過去——本站
  // 後端（ask.ts 的 buildHoldingsGrounding）本來就支援輕量、非按鈕觸發的持股
  // 問法，只是前端一直沒有把資料接上。預設參數在每次呼叫當下才求值，不會
  // 讀到舊的關注清單快照。
  async function send(question: string, holdings: ReturnType<typeof getWatchlist> = getWatchlist()) {
    const trimmed = question.trim();
    if (!trimmed || loading) return;
    const history = messages.map((m) => ({ role: m.role, content: m.text }));
    setMessages((m) => [...m, { role: "user", text: trimmed }]);
    setInput("");
    // 問題已經送出了，上一輪的語音錯誤提示沒有必要再留在畫面上。
    clearVoiceError();
    setLoading(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed, symbol: contextSymbol?.symbol, history, holdings }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "發生錯誤");
      setMessages((m) => [...m, { role: "assistant", text: data.answer }]);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", text: `抱歉，發生錯誤：${(err as Error).message}` }]);
    } finally {
      setLoading(false);
    }
  }

  // 「最後一則使用者訊息」的索引，不論當下是使用者剛送出問題（最後一則本身就是它）
  // 還是AI已經接著回完話（它變成倒數第二則）——見上面那個捲動 useEffect 為什麼要
  // 認的是同一個節點。
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50">
      {/* 使用者反映：關閉面板（按✕）再重新打開，畫面會跳回去而不是留在關閉前看到的
          位置。原本這裡是 `{open && (...)}`，關閉時整個面板連同裡面的scrollRef DOM
          節點一起被卸載，捲動位置當然保不住；重新打開等於從零生一個全新節點，捲動
          位置永遠是0。改成一直保留這個節點，只用 `hidden` 切換顯示/隱藏（不是卸載/
          重新掛載），瀏覽器原生就會記住隱藏前的捲動位置，重新顯示時完全不用自己
          額外處理。 */}
      <div className={open ? "" : "hidden"}>
        {/* Fixed px, not rem: this box's own size is deliberately independent
            of the site-wide root font-size (globals.css) — sizing it in rem
            meant a global text-size increase silently grew this floating
            panel too (448px -> 504px tall), which could push it past the top
            of a modest browser window since it's anchored to the bottom
            (fixed bottom-4 right-4) with nothing to shrink it back down,
            showing as the widget being cut off / not fully visible. A
            max-height safety clamp on top of the fixed size means this can't
            recur even if the root font-size changes again later. */}
        <div className="mb-3 flex h-[448px] max-h-[calc(100vh-6rem)] w-[352px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-(--gridline) bg-(--surface-1) shadow-xl">
          <div className="flex items-center justify-between border-b border-(--gridline) px-4 py-3">
            <div>
              <p className="font-semibold text-sm">AI 股票問答</p>
              {contextSymbol && (
                // Clearable: the widget lives in the root layout, so the
                // focus set by "問 AI 關於 X" outlived navigating away from
                // that stock's page. Asking "今天大盤表現如何？" from the
                // homepage afterwards was still being answered as a question
                // about X, with no way to undo it short of a reload.
                <p className="flex items-center gap-1 text-xs text-(--text-muted)">
                  目前聚焦：{contextSymbol.name}（{contextSymbol.symbol}）
                  <button
                    onClick={() => setContextSymbol(null)}
                    className="rounded px-1 leading-none hover:bg-(--page-plane) hover:text-(--text-primary)"
                    aria-label="取消聚焦此股票"
                    title="取消聚焦，改問一般問題"
                  >
                    ✕
                  </button>
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {messages.length > 0 && (
                <button
                  onClick={() => {
                    setMessages([]);
                    setContextSymbol(null);
                  }}
                  className="text-xs text-(--text-muted) hover:text-(--text-primary)"
                  title="清空對話"
                >
                  清空對話
                </button>
              )}
              <button onClick={() => setOpen(false)} className="text-(--text-muted) hover:text-(--text-primary)" aria-label="關閉">
                ✕
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <div className="space-y-2">
                {watchlist.length > 0 && (
                  <button
                    onClick={() => send("幫我分析一下我關注清單裡的每一檔股票", watchlist)}
                    // text-(--accent) on bg-(--accent-soft) measured 3.34:1 light /
                    // 2.23:1 dark — both under WCAG AA's 4.5:1 for text. text-primary
                    // on the same background clears 14.87:1 / 8.10:1 while the
                    // border+background still read as the same accent-tinted button.
                    className="block w-full rounded-md border border-(--accent) bg-(--accent-soft) px-3 py-2 text-left text-xs font-medium text-(--text-primary) hover:opacity-90"
                  >
                    📋 分析我的關注清單（{watchlist.length} 檔）
                  </button>
                )}
                <p className="text-xs text-(--text-muted)">試試看這樣問：</p>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="block w-full rounded-md border border-(--gridline) px-3 py-2 text-left text-xs hover:bg-(--page-plane)"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                ref={i === lastUserIndex ? lastUserMessageRef : undefined}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === "user" ? "bg-(--accent) text-white" : "bg-(--page-plane) text-(--text-primary)"
                  }`}
                >
                  {m.role === "assistant" ? <MarkdownLite text={m.text} /> : <p className="whitespace-pre-wrap">{m.text}</p>}
                </div>
              </div>
            ))}
            {loading && <p className="text-xs text-(--text-muted)">思考中…</p>}
          </div>

          <div className="border-t border-(--gridline) p-3">
            {(listening || voiceError) && (
              <p
                className={`mb-2 text-xs font-medium ${listening ? "text-(--accent)" : "text-(--price-up)"}`}
                role="status"
              >
                {listening ? "🎤 聆聽中…請說話" : `⚠️ ${voiceError}`}
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              // items-end：textarea 隨文字增高時，麥克風/送出按鈕要貼齊底部，不要被
              // 拉著一起變高、也不要卡在整個輸入區塊的垂直正中間看起來很奇怪。
              className="flex items-end gap-2"
            >
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  // 使用者已經改用打字了，上一次的語音錯誤紅字就該退場——否則
                  // 「沒有偵測到聲音」會一直掛在輸入框上方，看起來像是打的字有問題。
                  if (voiceError) clearVoiceError();
                }}
                onKeyDown={(e) => {
                  // Enter 送出、Shift+Enter 換行：多數聊天 App 的慣例，長輩不用另外
                  // 學新規則。isComposing 這個檢查是必要的——用注音/拼音打中文字時，
                  // 按 Enter 常常是「確認候選字」而不是「打完這句話」，沒有這個檢查
                  // 會變成選字選到一半就把問題送出去。
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                placeholder="輸入你的問題，或按🎤說話…"
                maxLength={500}
                rows={1}
                style={{ maxHeight: `${CHAT_TEXTAREA_MAX_HEIGHT_PX}px` }}
                className="min-w-0 flex-1 resize-none overflow-y-auto rounded-md border border-(--gridline) bg-(--surface-2) px-3 py-2 text-sm leading-snug focus:outline-none focus:ring-2 focus:ring-(--accent)"
              />
              <button
                type="button"
                onClick={toggleVoiceInput}
                aria-label={listening ? "停止語音輸入" : "開始語音輸入"}
                title={listening ? "停止語音輸入" : "語音輸入（用講的問問題）"}
                className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium ${
                  listening
                    ? "animate-pulse bg-(--price-up) text-white"
                    : "border border-(--gridline) bg-(--surface-2) text-(--text-primary) hover:bg-(--page-plane)"
                }`}
              >
                {listening ? "⏹" : "🎤"}
              </button>
              <button
                type="submit"
                disabled={loading}
                className="shrink-0 rounded-md bg-(--accent) px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                送出
              </button>
            </form>
            <p className="mt-1 text-[11px] text-(--text-muted)">按 Enter 傳送，Shift+Enter 換行</p>
          </div>
        </div>
      </div>

      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-(--accent) text-white shadow-lg hover:opacity-90"
        aria-label="開啟 AI 問答"
      >
        {open ? "✕" : "💬"}
      </button>
    </div>
  );
}
