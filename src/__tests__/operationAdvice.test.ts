import { describe, expect, it } from "vitest";
import { operationAdvice } from "@/lib/ai/operationAdvice";
import type { SiteRating } from "@/lib/ai/siteRating";

const base = (over: Partial<SiteRating>): SiteRating => ({
  code: "buy",
  label: "建議買進（現價 557 可分批買）",
  holdingCode: "add",
  holdingLabel: "可分批加碼",
  reason: "技術面支持、法人買超",
  supportCount: 4,
  againstCount: 0,
  zone: { low: 530, high: 540 },
  noChase: null,
  exit: 520,
  chaseHits: [],
  riskNote: null,
  ...over,
});

describe("關注清單操作建議（買／賣／續抱／不買，* ＝需觀察）", () => {
  it("沒持有：建議買進＝買、建議先不要買＝不買", () => {
    expect(operationAdvice(base({}), false)).toMatchObject({ action: "買", watch: false, text: "買" });
    expect(operationAdvice(base({ code: "avoid", label: "建議先不要買", holdingCode: "reduce", holdingLabel: "建議減碼" }), false)).toMatchObject({ action: "不買", text: "不買" });
  });

  it("持有中：加碼＝買、續抱＝續抱、減碼與出場＝賣", () => {
    expect(operationAdvice(base({ holdingCode: "add" }), true).text).toBe("買");
    expect(operationAdvice(base({ holdingCode: "hold", holdingLabel: "續抱" }), true).text).toBe("續抱");
    expect(operationAdvice(base({ holdingCode: "reduce", holdingLabel: "建議減碼" }), true).text).toBe("賣");
    expect(operationAdvice(base({ holdingCode: "exit", holdingLabel: "建議出場" }), true).text).toBe("賣");
  });

  it("需觀察（*）：結論確認期、短線風險、弱市況任一；說明逐條寫出原因", () => {
    const hold = base({ holdingCode: "hold", holdingLabel: "續抱", riskNote: "短線風險：RSI 82（超買）、觸及布林上緣" });
    const a = operationAdvice(hold, true);
    expect(a).toMatchObject({ action: "續抱", watch: true, text: "續抱*" });
    expect(a.tip).toContain("目前建議續抱，但需觀察");
    expect(a.tip).toContain("需觀察的原因");
    expect(a.tip).toContain("RSI 82");
    expect(operationAdvice(base({ pendingChange: "今天的資料指向建議先不要買，明天仍如此才改判" }), false)).toMatchObject({ text: "買*" });
    expect(operationAdvice(base({ marketNote: "大盤偏弱" }), false).watch).toBe(true);
    expect(operationAdvice(base({}), false).tip).not.toContain("需觀察");
  });

  it("說明文字標明持有狀態與免責", () => {
    expect(operationAdvice(base({}), true).tip).toContain("你持有中");
    expect(operationAdvice(base({}), false).tip).toContain("你還沒持有");
    expect(operationAdvice(base({}), false).tip).toContain("不構成投資建議");
  });
});
