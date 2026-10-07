/**
 * 本機 TS 腳本（backtest、eval）呼叫正式站 API 用的驗證標頭。
 * 網站 2026-10-07 起改成帳號制，改用服務金鑰 SERVICE_API_KEY（環境變數或 .env.local），
 * 必須跟 Vercel 上設定的同一組。
 */
import fs from "node:fs";
import path from "node:path";

function serviceKey(): string {
  const fromEnv = process.env.SERVICE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const envFile = path.resolve(import.meta.dirname, "..", ".env.local");
  if (fs.existsSync(envFile)) {
    const line = fs.readFileSync(envFile, "utf8").split(/\r?\n/).find((l) => l.startsWith("SERVICE_API_KEY="));
    if (line) return line.slice("SERVICE_API_KEY=".length).trim().replace(/^"|"$/g, "");
  }
  throw new Error("缺少 SERVICE_API_KEY（設環境變數或寫進 .env.local），無法呼叫正式站 API");
}

export function siteAuthHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${serviceKey()}` };
}
