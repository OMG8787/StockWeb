import type { Market } from "@/lib/data";

export const ASK_ABOUT_EVENT = "stockradar:ask-about";

export interface AskAboutDetail {
  symbol: string;
  market: Market;
  name: string;
}

/** 開啟右下角聊天視窗的「🎓 教學助手」分頁（可帶 question 預填、或 sectionId 直接開手冊那一章） */
export const HELP_OPEN_EVENT = "stockradar:help-open";

export interface HelpOpenDetail {
  view?: "ask" | "manual";
  sectionId?: string;
}
