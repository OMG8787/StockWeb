import { useCallback, useEffect, useRef, useState } from "react";

// 2026-09-23 從 ChatWidget.tsx 拆出來的語音輸入狀態機（Web Speech API 管理＋自動
// 重啟邏輯），原本佔了元件近一半篇幅、把「怎麼錄音」跟「怎麼畫聊天視窗」混在同一個
// 檔案裡，改語音行為要先在一堆 JSX 中間找到邏輯區塊。抽成獨立 hook 後，這裡只管
// 「開始/停止聆聽、把辨識結果寫回輸入框」，畫面怎麼呈現交給呼叫端。

// 使用者要求「語音輸入要手動停止，不要自己斷掉錄音」。continuous=true 已經能讓瀏覽器
// 在偵測到停頓後不自動結束辨識，但部分瀏覽器實作即使 continuous=true，長時間靜音後仍會
// 自己觸發 onend（不是使用者按停止鍵造成的）。這種情況要自動重新啟動辨識繼續聆聽，但要
// 設上限避免麥克風完全故障時無限重啟造成迴圈，超過上限就放棄並提示使用者自己再按一次。
const MAX_VOICE_RESTART_ATTEMPTS = 3;

// Web Speech API 沒有內建在 TypeScript 的 lib.dom.d.ts 裡（各瀏覽器支援度也不一致，
// Chrome/Edge 用 webkit 前綴），這裡只宣告本 hook 實際會用到的最小介面，避免用 `any`。
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

export interface UseVoiceInputOptions {
  /** 目前輸入框的文字——開始講話當下已有的內容會被保留，辨識結果接在後面。 */
  input: string;
  setInput: (value: string) => void;
  /** 呼叫端的面板是否開啟；變成 false 視同使用者要停止聆聽，會收掉麥克風。 */
  active: boolean;
}

export interface UseVoiceInputResult {
  listening: boolean;
  voiceError: string | null;
  toggleVoiceInput: () => void;
  clearVoiceError: () => void;
}

export function useVoiceInput({ input, setInput, active }: UseVoiceInputOptions): UseVoiceInputResult {
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
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

  // 呼叫端面板關閉時也要停止錄音。ChatWidget 掛在 root layout 裡常駐，關閉面板只是
  // 把 `open` 設成 false、元件本身從來不會卸載，所以上面那個「卸載時停止」的 cleanup
  // 在實際操作中根本不會被觸發——實測（規則三複查）確認：在「聆聽中」直接按 ✕ 關掉
  // 面板，瀏覽器會繼續開著麥克風錄音，分頁的錄音指示燈一直亮著，而且 listening 狀態
  // 卡住，重新打開面板還顯示「🎤 聆聽中…請說話」。對長輩來說「關掉視窗＝結束」是
  // 最直覺的收場方式，不能讓麥克風默默留在開啟狀態。
  useEffect(() => {
    if (active) return;
    teardownRecognition();
    // 這裡是「呼叫端關閉面板」這個外部訊號要同步收掉麥克風＋清狀態，沒有更好的時機點
    // 可以做這件事；這兩行從 ChatWidget.tsx 原地搬過來時邏輯完全沒變，原本在同一個
    // 元件檔案裡不會觸發這條規則，抽成獨立 hook 後才觸發，屬於這條規則對「跨檔案抽出
    // 的effect」判斷較嚴格的已知落差，不是這次重構引入的新行為問題。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setListening(false);
    setVoiceError(null);
  }, [active, teardownRecognition]);

  const toggleVoiceInput = useCallback(() => {
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
  }, [input, listening, setInput, teardownRecognition]);

  const clearVoiceError = useCallback(() => setVoiceError(null), []);

  return { listening, voiceError, toggleVoiceInput, clearVoiceError };
}
