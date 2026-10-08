/**
 * 把 Google 試算表（Apps Script）裡的資料搬進 Upstash Redis（2026-10-08 使用者要求資料庫改回線上 Redis）。
 *
 * 用法（在專案根目錄；.env.local 要有 AUTH_GAS_URL／AUTH_GAS_SECRET 與 KV_REST_API_URL／KV_REST_API_TOKEN
 * 或 UPSTASH_REDIS_REST_URL／UPSTASH_REDIS_REST_TOKEN）：
 *   node scripts/migrate-sheet-to-redis.mjs            # 預演：只讀試算表、列出會搬哪些資料，不寫 Redis
 *   node scripts/migrate-sheet-to-redis.mjs --apply    # 真的寫入 Redis（Redis 裡已有該表資料就跳過，避免蓋掉新資料）
 *   node scripts/migrate-sheet-to-redis.mjs --apply --force   # 已有資料也覆蓋（先確認！）
 *
 * 搬兩類資料：
 *  1. 帳號與功能資料表（Users、Sessions、LoginLog、Feedback、Holdings、Indicators、Strategies、Sims、SimTrades、SimNav、Alerts）
 *     → Redis hash `tbl:v1:<表名>`，格式見 src/lib/auth/redisStore.ts。
 *  2. 永久紀錄表（RatingLog、RatingConfirm、Learning、SimPortfolio、BriefArchive、ModelStats、VolumeHistory；
 *     試算表裡一個欄位一列）→ 還原成原本的 Redis 鍵（字串、hash、清單）。
 * 搬完後在 Vercel 設定 AUTH_STORE=redis 並重新部署即可切換；要換回試算表就刪掉 AUTH_STORE。
 */
import fs from "node:fs";
import { Redis } from "@upstash/redis";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const FORCE = args.has("--force");

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {
    // 沒有 .env.local：只靠環境變數
  }
  return env;
}
const env = loadEnv();
const GAS_URL = env.AUTH_GAS_URL;
const GAS_SECRET = env.AUTH_GAS_SECRET;
const R_URL = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
if (!GAS_URL || !GAS_SECRET) throw new Error("缺 AUTH_GAS_URL／AUTH_GAS_SECRET");
if (APPLY && (!R_URL || !R_TOKEN)) throw new Error("缺 Redis 連線設定（KV_REST_API_URL／KV_REST_API_TOKEN）");
const redis = R_URL && R_TOKEN ? new Redis({ url: R_URL, token: R_TOKEN }) : null;

const TABLE_KEYS = { Users: "UserId", Sessions: "SessionId" };
const keyOf = (t) => TABLE_KEYS[t] ?? "ID";
const ACCOUNT_TABLES = ["Users", "Sessions", "LoginLog", "Feedback", "Holdings", "Indicators", "Strategies", "Sims", "SimTrades", "SimNav", "Alerts"];
const DURABLE_TABLES = ["RatingLog", "RatingConfirm", "Learning", "SimPortfolio", "BriefArchive", "ModelStats", "VolumeHistory"];

/** 讀試算表一張表（結果網址只能讀一次，失敗就整個重送） */
async function readSheet(table) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ secret: GAS_SECRET, ops: [{ op: "read", table }] }),
        redirect: "manual",
      });
      const loc = res.headers.get("location");
      const r2 = loc ? await fetch(loc) : res;
      const data = JSON.parse(await r2.text());
      if (data.success && Array.isArray(data.data) && Array.isArray(data.data[0])) return data.data[0];
      throw new Error(data.message ?? "回應格式不正確");
    } catch (err) {
      if (attempt === 4) throw new Error(`讀 ${table} 失敗：${err.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

/** 永久紀錄表（一個欄位一列，長值切片）還原成 Redis 鍵：{ kind: s|h|l, value } */
function assemble(rows) {
  const groups = new Map();
  for (const r of rows) {
    const id = `${r.Key}§${r.Field}`;
    groups.set(id, [...(groups.get(id) ?? []), r]);
  }
  const out = new Map();
  for (const parts of groups.values()) {
    const first = parts.find((p) => p.Part === "0");
    if (!first) continue;
    const n = Number(first.Parts) || 1;
    const sorted = parts.filter((p) => Number(p.Part) < n).sort((a, b) => Number(a.Part) - Number(b.Part));
    if (sorted.length < n) continue; // 切片不齊（寫到一半）
    const text = sorted.map((p) => p.Value).join("");
    const kind = first.Kind || "s";
    const cur = out.get(first.Key);
    if (kind === "s") out.set(first.Key, { kind, value: text });
    else if (kind === "h") out.set(first.Key, { kind, value: { ...(cur?.value ?? {}), [first.Field]: text } });
    else out.set(first.Key, { kind, value: [...(cur?.value ?? []), [first.Field, text]] });
  }
  for (const [k, v] of out) if (v.kind === "l") out.set(k, { kind: "l", value: v.value.sort((a, b) => a[0].localeCompare(b[0])).map((x) => x[1]) });
  return out;
}

let seq = 0;
const order = () => Date.now() * 1000 + (seq++ % 1000);
const clean = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? "")]));

console.log(APPLY ? "【正式寫入 Redis】" : "【預演：不會寫入 Redis】", FORCE ? "（--force：已有資料也覆蓋）" : "");

for (const table of ACCOUNT_TABLES) {
  const rows = (await readSheet(table)).map(clean);
  const hash = `tbl:v1:${table}`;
  let note = "";
  if (APPLY && rows.length) {
    const existing = await redis.hlen(hash);
    if (existing > 0 && !FORCE) note = `（Redis 已有 ${existing} 列，跳過）`;
    else {
      const values = {};
      for (const r of rows) values[r[keyOf(table)]] = { ...r, __n: String(order()) };
      // 一次寫太多會超過單次請求大小：分批
      const entries = Object.entries(values);
      for (let i = 0; i < entries.length; i += 100) await redis.hset(hash, Object.fromEntries(entries.slice(i, i + 100)));
      note = "→ 已寫入";
    }
  }
  console.log(`${table.padEnd(12)} ${String(rows.length).padStart(5)} 列 ${note}`);
}

for (const table of DURABLE_TABLES) {
  const rows = await readSheet(table);
  const keys = assemble(rows);
  let wrote = 0;
  let skipped = 0;
  if (APPLY) {
    for (const [key, { kind, value }] of keys) {
      if (!FORCE && (await redis.exists(key))) {
        skipped++;
        continue;
      }
      if (kind === "s") await redis.set(key, value);
      else if (kind === "h") await redis.hset(key, value);
      else if (value.length) await redis.rpush(key, ...value);
      wrote++;
    }
  }
  console.log(`${table.padEnd(14)} 試算表 ${String(rows.length).padStart(5)} 列 → Redis 鍵 ${keys.size} 個${APPLY ? `（寫入 ${wrote}、已存在跳過 ${skipped}）` : ""}`);
}

console.log(APPLY ? "\n完成。接著在 Vercel 設定環境變數 AUTH_STORE=redis 並重新部署；要換回試算表就刪掉 AUTH_STORE。" : "\n預演完成；確認數字沒問題後加 --apply 正式搬。");
