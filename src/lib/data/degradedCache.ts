import { peekCached, writeCached } from "./cache";

/**
 * `cached()` 的變體：算出來是**空清單**時只給一個很短的 TTL，真的算出資料才
 * 給正常的長 TTL。
 *
 * 2026-09-20 正式站實際踩到的 bug：AI 問答被問「有沒有 MACD 跟 KD 都黃金交叉
 * 的股票」時，連續 30 分鐘以上都回答「資料裡沒有提供台股的技術指標篩選清單，
 * 只有美股的」——台股整個區塊憑空消失。根因不是計算太慢或逾時（實測台股前 120
 * 檔的 3 個月 K 線在併發 20 下只要約 10 秒、120/120 全部成功），而是：
 * `searchStocks({market:"TW"})` 在某個瞬間因為上游（TWSE/TPEx 報價或清單）
 * 暫時性降級而回傳 0 筆，`getTechnicalScreen("TW")` 於是算出 `[]`，這個 `[]`
 * 就被 `cached()` 當成正常結果**整整存活 30 分鐘**。更糟的是每 5 分鐘一次的
 * warm-cache 排程重新呼叫時只會讀到這份快取的 `[]`，不會重算，所以系統完全
 * 沒有自我修復的機會，只能乾等 TTL 到期。
 *
 * 這跟 universe.ts 早先修過的「TW_UNIVERSE_DEGRADED_TTL_MS」是同一類問題，
 * 做法也刻意跟那邊一致：用 peekCached/writeCached 自己決定要寫多長的 TTL，
 * 並自己補一個 single-flight 旗標（`cached()` 內建的去重在這裡用不到，而這兩
 * 份資料都很昂貴，沒有去重會讓多個同時進來的 cache miss 各自重跑一次全市場
 * 掃描）。空結果仍然會被短暫快取（而不是完全不快取），是為了避免上游真的掛掉
 * 時每一個請求都去重打一次全市場掃描。
 */
const degradedEmptyInFlight = new Map<string, Promise<unknown[]>>();

export async function cachedListWithDegradedEmptyTtl<T>(
  key: string,
  ttlMs: number,
  degradedTtlMs: number,
  load: () => Promise<T[]>
): Promise<T[]> {
  const hit = await peekCached<T[]>(key);
  if (hit) return hit;
  const pending = degradedEmptyInFlight.get(key);
  if (pending) return (await pending) as T[];
  const promise = (async () => {
    const value = await load();
    await writeCached(key, value, value.length > 0 ? ttlMs : degradedTtlMs);
    return value;
  })();
  degradedEmptyInFlight.set(key, promise as Promise<unknown[]>);
  try {
    return await promise;
  } finally {
    degradedEmptyInFlight.delete(key);
  }
}

/**
 * 同一個概念的單值版本：抓到資料才給正常 TTL，抓不到（`null`）只給一個很短的
 * 降級 TTL。
 *
 * 2026-09-21 為了修 `/api/indices` 間歇性漏掉台股加權指數（TAIEX）而加。原本
 * `getIndices()` 是用 `cached()` 逐檔快取，抓失敗時 `catch` 回傳的 `null`
 * **會被當成正常結果**寫進記憶體快取**跟共用的 Redis**，存活整個 TTL
 * （台股盤中 60 秒、其餘 20 秒）。也就是說上游只要掉一次連線，全站每一位
 * 訪客的首頁大盤卡片就會有最長 60 秒都顯示「大盤指數目前無法取得」，即使
 * 上游下一秒就恢復了也一樣——這正是那個 bug 被觀察到的樣子（同一時間直接打
 * 上游 t00 明明有資料）。
 *
 * 注意 `peekCached()` 對「沒有這個 key」回傳 `undefined`、對「這個 key 存的
 * 就是 null」回傳 `null`，兩者可以區分，所以這裡用 `!== undefined` 判斷命中，
 * 不能沿用上面陣列版的 `if (hit)`（`null` 是 falsy，會被誤判成 miss、讓降級
 * 快取形同不存在）。
 */
const degradedNullInFlight = new Map<string, Promise<unknown>>();

export async function cachedWithDegradedNullTtl<T>(
  key: string,
  ttlMs: number,
  degradedTtlMs: number,
  load: () => Promise<T | null>
): Promise<T | null> {
  const hit = await peekCached<T | null>(key);
  if (hit !== undefined) return hit;
  const pending = degradedNullInFlight.get(key);
  if (pending) return (await pending) as T | null;
  const promise = (async () => {
    const value = await load();
    await writeCached(key, value, value === null ? degradedTtlMs : ttlMs);
    return value;
  })();
  degradedNullInFlight.set(key, promise);
  try {
    return (await promise) as T | null;
  } finally {
    degradedNullInFlight.delete(key);
  }
}
