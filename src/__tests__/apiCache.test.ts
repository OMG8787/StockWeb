import { describe, expect, it } from "vitest";
import { privateCache } from "@/lib/apiCache";
import { CLIENT_REFRESH_IDLE_MS, CLIENT_REFRESH_LIVE_MS, SERVER_REFRESH_LIVE_MS } from "@/lib/autoRefresh";

describe("瀏覽器端快取標頭", () => {
  it("只給瀏覽器自己快取（private），可帶 stale-while-revalidate", () => {
    expect(privateCache(120)).toEqual({ "Cache-Control": "private, max-age=120" });
    expect(privateCache(3600, 86400)).toEqual({ "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400" });
    expect(privateCache(60)["Cache-Control"]).not.toMatch(/public|s-maxage/);
  });

  it("慢資料的前端更新節奏：用戶端卡片 5／20 分鐘、伺服器渲染區塊 3 分鐘（比 Redis 額度吃緊前寬鬆）", () => {
    expect(CLIENT_REFRESH_LIVE_MS).toBe(5 * 60_000);
    expect(CLIENT_REFRESH_IDLE_MS).toBe(20 * 60_000);
    expect(SERVER_REFRESH_LIVE_MS).toBe(3 * 60_000);
  });
});
