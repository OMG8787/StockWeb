// Safety net for a real production leak an Opus QA pass found: in ~11% of
// trials the model echoed the internal "not found" grounding marker verbatim
// as its entire reply instead of paraphrasing it (sometimes literally just
// "【查詢結果】" with nothing else). Rewording the marker in the prompt made
// it less answer-shaped, but this strips any marker text that still leaks
// through so a user never sees a bare bracket token.
const LEAKED_MARKER_PATTERN = /(?:【內部系統標記[^】]*】|【查詢結果】)/g;

export function sanitizeLeakedMarkers(answer: string): string {
  const cleaned = answer.replace(LEAKED_MARKER_PATTERN, "").trim();
  if (cleaned) return cleaned;
  return "目前查不到這檔股票/公司的資料，可能是名稱或代號打錯、或不在本站資料涵蓋範圍（本站台股目前涵蓋證交所上市（TWSE）、櫃買中心上櫃（TPEx）與興櫃（Emerging）公司；美股則是約150多檔精選跨產業大型股，不是完整美股市場，用公司名稱或代號都可以查）。";
}

/**
 * AI 供應商整個失敗時的退路。只印 userSafe 的資料區塊（見 groundingSections 上方
 * 那段說明：原本是把整包 grounding 照印，結果把寫給模型看的指令跟內部標記一起攤給
 * 使用者看）。
 */
export function buildCannedAnswer(
  sections: Array<{ text: string; userSafe: boolean }>,
  groundedSymbol: string | undefined,
  reason: string
): string {
  const safeText = sections
    .filter((s) => s.userSafe && s.text)
    .map((s) => s.text)
    .join("\n\n");
  const header = `AI 分析暫時無法產生（原因：${reason.replace(/。$/, "")}），過一下下再問一次通常就好了。`;
  if (!safeText) {
    return `${header}\n\n目前也沒有可以直接顯示的現成資料，請稍後再試一次。`;
  }
  return [
    header,
    "",
    groundedSymbol ? `先把查到的 ${groundedSymbol} 原始資料放在下面給你看：` : "先把查到的原始市場資料放在下面給你看：",
    "",
    safeText,
  ].join("\n");
}
