import { NextResponse } from "next/server";
import { INDICATOR_TYPES } from "@/lib/strategy/indicatorCatalog";
import { privateCache } from "@/lib/apiCache";

/** 參考指標的系統清單（不含計算函式），給參考指標頁建立表單用。 */
export function GET() {
  return NextResponse.json({
    types: INDICATOR_TYPES.map(({ id, label, group, description, params, twOnly }) => ({ id, label, group, description, params, twOnly: !!twOnly })),
  }, { headers: privateCache(3600, 86400) }); // 指標目錄只隨網站改版才變
}
