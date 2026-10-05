"use client";

import { useState } from "react";

/**
 * 表格「產業」欄內容（關注清單與 StockTable 共用）。
 * 手機／平板（<1280px）：最多 2 行完整顯示，超過 2 行才截斷，點一下展開全文、再點收合；
 * 桌機（>=1280px）：維持原樣，樣式由 desktopClassName 決定（關注清單單行截斷，StockTable 自然換行）。
 */
export default function IndustryCell({ text, desktopClassName = "" }: { text: string; desktopClassName?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      onClick={() => setExpanded((v) => !v)}
      title={text}
      className={`w-[8.5rem] cursor-pointer text-[13px] leading-snug break-words whitespace-normal xl:w-auto xl:cursor-default xl:text-sm xl:leading-normal ${
        expanded ? "" : "line-clamp-2"
      } xl:line-clamp-none ${desktopClassName}`}
    >
      {text}
    </div>
  );
}
