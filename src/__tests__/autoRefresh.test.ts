import { describe, expect, it } from "vitest";
import {
  CLIENT_REFRESH_IDLE_MS,
  CLIENT_REFRESH_LIVE_MS,
  SERVER_REFRESH_IDLE_MS,
  SERVER_REFRESH_LIVE_MS,
  SERVER_REFRESH_SHELL_MS,
  clientRefreshMs,
  isAnyMarketLive,
  serverRefreshMs,
} from "@/lib/autoRefresh";

/** 台北時間固定時鐘（2026-10-05 週一、10-03 週六）。 */
const taipei = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+08:00`);

describe("自動更新節奏（待在同一頁不動也要更新）", () => {
  it("台股盤中（週一 10:00）：伺服器渲染區塊 60 秒、用戶端卡片 3 分鐘", () => {
    const now = taipei("2026-10-05", "10:00");
    expect(isAnyMarketLive(now)).toBe(true);
    expect(serverRefreshMs("/stock/2330", now)).toBe(SERVER_REFRESH_LIVE_MS);
    expect(clientRefreshMs(now)).toBe(CLIENT_REFRESH_LIVE_MS);
  });

  it("美股盤中（台北週一 22:00＝美東 10:00）也算盤中", () => {
    const now = taipei("2026-10-05", "22:00");
    expect(isAnyMarketLive(now)).toBe(true);
    expect(serverRefreshMs("/stock/AAPL", now)).toBe(SERVER_REFRESH_LIVE_MS);
  });

  it("兩個市場都收盤（週六白天）：伺服器 10 分鐘、用戶端 10 分鐘", () => {
    const now = taipei("2026-10-03", "11:00");
    expect(isAnyMarketLive(now)).toBe(false);
    expect(serverRefreshMs("/stock/2330", now)).toBe(SERVER_REFRESH_IDLE_MS);
    expect(clientRefreshMs(now)).toBe(CLIENT_REFRESH_IDLE_MS);
  });

  it("各路徑：個股頁與成績看板要刷新、外殼為主的頁面慢刷、純用戶端抓取的頁面不用 router.refresh", () => {
    const now = taipei("2026-10-05", "10:00");
    expect(serverRefreshMs("/scoreboard", now)).toBe(SERVER_REFRESH_IDLE_MS);
    expect(serverRefreshMs("/", now)).toBe(SERVER_REFRESH_SHELL_MS);
    expect(serverRefreshMs("/highlights", now)).toBe(SERVER_REFRESH_SHELL_MS);
    for (const p of ["/search", "/action", "/news", "/login", "/portfolio"]) expect(serverRefreshMs(p, now)).toBeNull();
  });

  it("盤中節奏不比全站報價輪詢（30 秒）更密，避免大幅增加伺服器用量", () => {
    expect(SERVER_REFRESH_LIVE_MS).toBeGreaterThanOrEqual(60_000);
    expect(CLIENT_REFRESH_LIVE_MS).toBeGreaterThanOrEqual(60_000);
  });
});
