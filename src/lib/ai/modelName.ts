/**
 * 模型 id → 好讀名稱（每則 AI 回答下方「由 X 回答」、今日建議／快報卡片底部、成績看板「各模型」用；純邏輯、有測試）。
 * 未知格式原樣顯示。
 */

const cap = (w: string) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));

export function displayModelName(id: string | null | undefined): string {
  if (!id) return "";
  const raw = id.trim().replace(/^models\//, "");
  // gemini-2.5-flash、gemini-2.5-flash-lite、gemini-2.0-flash-001
  let m = raw.match(/^gemini-(.+)$/i);
  if (m) {
    const parts = m[1].split("-").filter((p) => !/^\d{3}$/.test(p) && p !== "latest" && !/^preview/.test(p));
    return `Gemini ${parts.map(cap).join(" ")}`;
  }
  // nvidia/nemotron-3-super-120b-a12b → NVIDIA Nemotron 3 Super
  m = raw.match(/^nvidia\/(.+)$/i);
  if (m) {
    const parts = m[1].split("-").filter((p) => !/^\d+b$/i.test(p) && !/^a\d+b$/i.test(p));
    return `NVIDIA ${parts.map(cap).join(" ")}`;
  }
  // openai/gpt-oss-120b（Groq 上的開源模型）→ Groq GPT-OSS 120B
  m = raw.match(/^openai\/gpt-oss-(\d+)b$/i);
  if (m) return `Groq GPT-OSS ${m[1]}B`;
  // claude-sonnet-5 → Claude Sonnet 5
  m = raw.match(/^claude-(.+)$/i);
  if (m) return `Claude ${m[1].split("-").map(cap).join(" ")}`;
  return raw;
}

/** API 回應／快取物件裡帶的模型資訊。 */
export interface ModelInfo {
  id: string;
  name: string;
}

export function modelInfo(id: string | null | undefined): ModelInfo | undefined {
  return id ? { id, name: displayModelName(id) } : undefined;
}
