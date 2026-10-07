// 前端也要用、但不能從 accounts.ts 匯入（那邊有 Node 專用模組）的常數；accounts.ts 從這裡讀，只有一份。
export const MIN_PASSWORD_LENGTH_CLIENT = 8;
