import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { getAlertConfig, StrategyError } from "@/lib/strategy/store";
import { getSmartList, runSmartList } from "@/lib/strategy/smartList";

// 立即更新一次要掃描約 300 檔（第一次抓日K較久）
export const maxDuration = 300;

/** 我的智能清單：GET＝設定＋清單內容；POST { action: "run" }＝立即更新一次（設定存在即時提醒設定，POST /api/strategy/alerts） */
export const GET = (req: NextRequest) =>
  handle(req, async (o) => {
    const [cfg, data] = await Promise.all([getAlertConfig(o.userId), getSmartList(o.userId)]);
    return { config: cfg.smartList, trackSmartList: cfg.trackSmartList, data };
  });

export const POST = (req: NextRequest) =>
  handle(req, async (o) => {
    const b = await body<{ action?: string }>(req);
    if (b.action !== "run") throw new StrategyError("不支援的操作");
    const cfg = await getAlertConfig(o.userId);
    if (cfg.smartList.strategyIds.length === 0) throw new StrategyError("請先選至少一個策略並儲存");
    const now = new Date();
    const day = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
    const res = await runSmartList(o.userId, cfg.smartList, { slot: "manual", slotKey: `${day}|manual|${now.getTime()}`, now, deadline: Date.now() + 240_000 });
    return { data: res.data, note: res.note };
  });
