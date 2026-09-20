"use client";

import { useEffect, useRef } from "react";
import { taipeiDayKey, type PollDecision } from "@/lib/pollingSchedule";

export interface LiveFetchContext {
  /** 這一輪評估的時間點（所有市場判斷都用同一個時間，避免同一輪前後不一致） */
  now: Date;
  /** 是不是元件掛載後的第一次（此時手上可能還沒有任何資料） */
  mount: boolean;
  /** 是不是 14:40 的收盤補抓 */
  settle: boolean;
}

export interface LivePollingOptions {
  /** 這一刻要不要抓、下一次什麼時候再評估（通常直接轉呼叫 lib/pollingSchedule 的函式） */
  decide: (now: Date, settledDayKey: string | null) => PollDecision;
  /** 真的去抓資料。丟例外會被吞掉（維持畫面上最後一次成功的資料），下一輪照常繼續。 */
  onFetch: (ctx: LiveFetchContext) => Promise<void> | void;
  /** 掛載時無論現在是不是交易時段都先抓一次（畫面上還沒有任何資料時要設 true） */
  fetchOnMount?: boolean;
  /** 改變時整組重新啟動（例如切換股票代號、關注清單內容變了） */
  restartKey?: string;
}

/**
 * 全站即時輪詢的共用 hook：用「一個 setTimeout 鏈」取代固定的 setInterval，
 * 因為這次的規則不是單一固定間隔，而是會隨時間變化的節奏——
 * 盤中 10 秒一次、收盤後完全不打 API、14:40 再補抓一次。
 *
 * 為什麼是 setTimeout 鏈而不是 setInterval：
 *  1. 14:30 之後輪詢已經停掉了，若只靠「輪詢迴圈裡判斷現在幾點」，迴圈本身
 *     不存在就永遠不會執行到 14:40 那一次。改成每次都由 pollingSchedule 算出
 *     「下一次什麼時候再評估」，非交易時段就把 timer 精準排到 14:40 那一刻。
 *  2. 下一次的等待時間會扣掉這次抓取實際花掉的時間，讓實測間隔貼近 10 秒，
 *     同時保證上一次請求結束後才發下一次，不會塞車重疊。
 */
export function useLivePolling({ decide, onFetch, fetchOnMount = false, restartKey = "" }: LivePollingOptions): void {
  const decideRef = useRef(decide);
  const fetchRef = useRef(onFetch);
  // 在 effect 裡更新（而不是 render 當下直接賦值），避免在 render 階段做副作用；
  // 這個 effect 宣告在輪詢 effect 前面，所以每次 render 後一定先於輪詢被更新。
  useEffect(() => {
    decideRef.current = decide;
    fetchRef.current = onFetch;
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 「今天的 14:40 補抓已經做過了」——記台北日期字串，跨日自動失效。
    let settledDayKey: string | null = null;
    let mount = true;

    async function run() {
      if (cancelled) return;
      const startedAt = Date.now();
      const now = new Date();
      const decision = decideRef.current(now, settledDayKey);
      if (decision.settle) settledDayKey = taipeiDayKey(now);
      const isMountFetch = mount && fetchOnMount;
      mount = false;

      if (decision.fetch || isMountFetch) {
        try {
          await fetchRef.current({ now, mount: isMountFetch, settle: decision.settle });
        } catch {
          // best-effort：保留畫面上最後一次成功的資料，下一輪再試
        }
      }
      if (cancelled) return;
      const elapsed = Date.now() - startedAt;
      timer = setTimeout(run, Math.max(500, decision.nextCheckMs - elapsed));
    }

    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchOnMount, restartKey]);
}
