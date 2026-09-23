"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ASK_ABOUT_EVENT, type AskAboutDetail } from "@/lib/chatEvents";
import { getWatchlist, WATCHLIST_CHANGED_EVENT } from "@/lib/watchlist";
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

// 使用者要求「語音輸入要手動停止，不要自己斷掉錄音」。continuous=true 已經能讓瀏覽器
// 在偵測到停頓後不自動結束辨識，但部分瀏覽器實作即使 continuous=true，長時間靜音後仍會
// 自己觸發 onend（不是使用者按停止鍵造成的）。這種情況要自動重新啟動辨識繼續聆聽，但要
// 設上限避免麥克風完全故障時無限重啟造成迴圈，超過上限就放棄並提示使用者自己再按一次。
const MAX_VOICE_RESTART_ATTEMPTS = 3;

// 輸入框改成可增高的 textarea 後，最多讓它長到這個高度（約 5 行文字），超過就內部捲動，
// 避免把整個聊天面板（有 max-h-[calc(100vh-6rem)] 的尺寸限制）撐爆版面。
const CHAT_TEXTAREA_MAX_HEIGHT_PX = 112;

// Web Speech API 沒有內建在 TypeScript 的 lib.dom.d.ts 裡（各瀏覽器支援度也不一致，
// Chrome/Edge 用 webkit 前綴），這裡只宣告本元件實際會用到的最小介面，避免用 `any`。
interface SpeechRecognitionResultEvent extends Event {
  results: {
    length: number;
    [index: number]: { length: number; [index: number]: { transcript: string } };
  };
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

// 長輩看得懂的簡短說法，涵蓋常見的語音辨識失敗情境。
const VOICE_ERROR_MESSAGES: Record<string, string> = {
  "not-allowed": "請允許使用麥克風，才能用語音輸入喔。",
  "permission-denied": "請允許使用麥克風，才能用語音輸入喔。",
  "no-speech": "沒有偵測到聲音，請再靠近一點、慢慢說一次。",
  "audio-capture": "找不到麥克風，請確認裝置有連接麥克風。",
  network: "網路連線有問題，請稍後再試一次。",
  // 注意：刻意不收錄 "aborted"。使用者自己按下停止鈕、或關閉對話面板時，瀏覽器就會
  // 發出 aborted，那是「照使用者的意思取消」而不是出錯，用紅色 ⚠️ 警告去講只會讓人
  // 以為自己弄壞了什麼。aborted 在 onerror 裡單獨處理成「不顯示任何訊息」。
};

export default function ChatWidget() {
  const watchlist = useSyncExternalStore(subscribeToWatchlist, getWatchlist, () => EMPTY_WATCHLIST);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [contextSymbol, setContextSymbol] = useState<AskAboutDetail | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 指向「目前這一輪對話裡，使用者剛送出的那則問題」的DOM節點——見下面那個
  // scroll useEffect：問完問題後要把畫面捲到「使用者的問題在最上面」，不是
  // 捲到最下面，讓人可以直接往下看AI的完整回答，不用先看到答案最後一段。
  const lastUserMessageRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // 使用者按下🎤開始講話「當下」輸入框裡已經有的文字（例如自己先打一半、或從個股頁
  // 「問AI關於」帶進來的預填問句）——語音辨識的內容要接在這段後面，不能蓋掉。
  const voiceBaseTextRef = useRef("");
  // 這一輪辨識（從上次 start() 到現在）目前為止聽到的完整內容。continuous=true 時
  // event.results 是「這次 start() 之後的累積結果」，每次 onresult 都要整段重建，
  // 不能用「接在舊 input 後面」的方式疊加，否則同一段話會被重複疊加好幾次。
  const lastFinalTranscriptRef = useRef("");
  // true = 使用者自己按停止鈕、或關閉面板／卸載元件；false = 辨識還在使用者要求的
  // 「聆聽中」狀態，只是瀏覽器自己把這次的 recognition 實例結束掉（例如長時間靜音）。
  // onend 靠這個旗標判斷「使用者是不是真的要停止」，是不是要自動重新啟動繼續聆聽。
  const stoppedByUserRef = useRef(true);
  // 連續自動重啟的次數，成功聽到內容（onresult）就歸零；超過上限代表麥克風/辨識服務
  // 一直啟動失敗，放棄自動重啟，避免無限迴圈。
  const restartAttemptsRef = useRef(0);

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

  // 徹底收掉目前這個語音辨識實例：先把 callback 拆掉再 stop()。
  // 拆 callback 是必要的——stop() 之後瀏覽器仍會非同步補發一次 onend，如果那時
  // 使用者已經重新開始了新一輪辨識，殘留的 onend 會把新一輪的 listening 狀態誤關掉。
  const teardownRecognition = useCallback(() => {
    // 保險：不管是不是使用者主動按停止鍵，只要走到「徹底收掉」這條路（面板關閉、
    // 元件卸載、或開始新一輪之前的清理），一律視為「使用者要停止」，避免萬一
    // onend 在 callback 被拆掉之前搶先觸發、又跑去嘗試自動重啟辨識。
    stoppedByUserRef.current = true;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      // 尚未開始/已經結束的實例呼叫 stop() 不該讓整個元件炸掉，忽略即可。
    }
  }, []);

  // 元件卸載時務必停止語音辨識，避免瀏覽器繼續在背景錄音、造成資源浪費或殘留的
  // onresult/onend callback 觸發已經不存在的 state setter。
  useEffect(() => {
    return () => {
      teardownRecognition();
    };
  }, [teardownRecognition]);

  // 關閉對話面板時也要停止錄音。這個元件掛在 root layout 裡常駐，關閉面板只是把
  // `open` 設成 false、元件本身從來不會卸載，所以上面那個「卸載時停止」的 cleanup
  // 在實際操作中根本不會被觸發——實測（規則三複查）確認：在「聆聽中」直接按 ✕ 關掉
  // 面板，瀏覽器會繼續開著麥克風錄音，分頁的錄音指示燈一直亮著，而且 listening 狀態
  // 卡住，重新打開面板還顯示「🎤 聆聽中…請說話」。對長輩來說「關掉視窗＝結束」是
  // 最直覺的收場方式，不能讓麥克風默默留在開啟狀態。
  useEffect(() => {
    if (open) return;
    teardownRecognition();
    setListening(false);
    setVoiceError(null);
  }, [open, teardownRecognition]);

  function toggleVoiceInput() {
    if (listening) {
      // 使用者主動按停止鈕：標記起來，讓稍後觸發的 onend 知道「這是使用者要的結束」，
      // 不要去嘗試自動重新啟動。
      stoppedByUserRef.current = true;
      recognitionRef.current?.stop();
      return;
    }

    const SpeechRecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      // 不悶不吭聲：偵測不到 API 時明確告知使用者，不要讓按鈕看起來毫無反應。
      setVoiceError("您的瀏覽器不支援語音輸入，請改用輸入文字（建議改用電腦版 Chrome 或 Edge 瀏覽器）。");
      return;
    }

    setVoiceError(null);
    // 保險：開始新一輪之前，先把任何殘留的舊實例收乾淨（例如上一輪的 onend 因為
    // 瀏覽器分頁被切到背景而遲遲沒送達），避免兩個實例同時握著麥克風。
    teardownRecognition();
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "zh-TW";
    // 使用者要求「開始錄音後要直到手動按停止才結束，不要自己斷掉」。continuous=true
    // 讓瀏覽器在偵測到一段話講完（停頓）後不會自動結束辨識，而是繼續聆聽下一段。
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    // 重置這一輪語音工作階段的狀態：捕捉「開始講話當下」輸入框已有的文字，之後
    // 辨識到的內容都接在這段後面，不會蓋掉使用者原本打好或預填的問句。
    voiceBaseTextRef.current = input.trim();
    lastFinalTranscriptRef.current = "";
    stoppedByUserRef.current = false;
    restartAttemptsRef.current = 0;

    recognition.onresult = (event) => {
      // continuous=true 時，每次 onresult 收到的 event.results 是「這次 start() 以來
      // 累積至今」的完整結果，不是只有新增的那一小段——所以每次都要整段重建，不能
      // 用「接在上一次 setInput 結果後面」的方式疊加，否則同一段話會被重複疊加。
      let combinedFinal = "";
      for (let i = 0; i < event.results.length; i++) {
        const segment = event.results[i]?.[0]?.transcript?.trim();
        if (segment) combinedFinal = combinedFinal ? `${combinedFinal} ${segment}` : segment;
      }
      if (!combinedFinal) return;
      lastFinalTranscriptRef.current = combinedFinal;
      // 有聽到內容了，代表辨識運作正常，重啟計數器歸零——避免「講幾句話、中間停頓
      // 幾次」被誤算成連續失敗，提早觸發「放棄自動重啟」。
      restartAttemptsRef.current = 0;
      const base = voiceBaseTextRef.current.trim();
      // 只填入輸入框、不自動送出——語音辨識偶爾會有錯字，讓使用者先看過再按送出。
      setInput(base ? `${base} ${combinedFinal}` : combinedFinal);
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" && !stoppedByUserRef.current) {
        // 只是長輩講話中間停頓太久、暫時沒偵測到聲音——不是使用者要停止，維持
        // 「聆聽中」，不顯示錯誤。要不要重啟交給 onend 判斷（部分瀏覽器 no-speech
        // 之後還是會接著觸發 onend，即使已經設定 continuous=true）。
        return;
      }
      setListening(false);
      if (event.error === "aborted") {
        // 使用者自己喊停（按停止鈕或關閉面板），不是錯誤，不要跳紅字嚇人。
        stoppedByUserRef.current = true;
        setVoiceError(null);
        return;
      }
      // 真正發生錯誤（權限被拒、找不到麥克風、網路問題等），之後 onend 不該再嘗試
      // 自動重啟，讓使用者自己判斷要不要重新按🎤。
      stoppedByUserRef.current = true;
      setVoiceError(VOICE_ERROR_MESSAGES[event.error] ?? "語音辨識發生錯誤，請再試一次或改用輸入文字。");
    };
    recognition.onend = () => {
      if (stoppedByUserRef.current) {
        setListening(false);
        return;
      }
      // 使用者還沒按停止鍵，瀏覽器卻自己把這次辨識結束了（例如長時間靜音）——依需求
      // 「不要自己斷掉錄音」，把目前為止聽到的內容併入下一輪的基底文字，重新啟動同一個
      // 實例繼續聆聽，而不是就此中斷、把狀態切回「未聆聽」。
      if (restartAttemptsRef.current >= MAX_VOICE_RESTART_ATTEMPTS) {
        setListening(false);
        setVoiceError("語音輸入不斷中斷，請再按一次🎤重新開始。");
        return;
      }
      restartAttemptsRef.current += 1;
      const base = voiceBaseTextRef.current.trim();
      const heard = lastFinalTranscriptRef.current.trim();
      voiceBaseTextRef.current = base ? (heard ? `${base} ${heard}` : base) : heard;
      lastFinalTranscriptRef.current = "";
      try {
        recognition.start();
        // listening 狀態維持不變（一直是 true）：對使用者來說這只是背景的自動接續，
        // 畫面上應該完全看不出中斷過。
      } catch {
        setListening(false);
        setVoiceError("語音輸入中斷，請再按一次🎤重新開始。");
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setVoiceError("語音輸入啟動失敗，請再試一次或改用輸入文字。");
      setListening(false);
    }
  }

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
    setVoiceError(null);
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
                  if (voiceError) setVoiceError(null);
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
