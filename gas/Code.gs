// ============================================================
// 股情雷達 帳號與回饋資料庫（Google Apps Script，綁在 Google 試算表上）
//
// 架構（參考 FonegleWeb 的帳號／權限設計）：
//   瀏覽器 ──> Next.js（Vercel，帳號邏輯、密碼雜湊、權限檢查都在這裡）
//          ──> 本程式（只負責讀寫試算表）──> Google 試算表
//
// - 只接受帶正確 API_SECRET 的請求：這個網址只給 Next.js 伺服器呼叫，瀏覽器
//   永遠拿不到金鑰，也不會直接呼叫這裡。
// - 本程式刻意只做「通用的表格讀寫」，帳號規則全部在 Next.js
//   （src/lib/auth/accounts.ts），本機開發用假後端時行為才會一模一樣。
// - 欄位以 Next.js 傳來的資料為準：寫入時遇到新欄位會自動加在最右邊。
//
// 部署步驟見 docs/auth-setup.md。
// ============================================================

// 工作表與主鍵（欄位清單只用於 setup 建立表頭；之後新增欄位會自動補上）
const TABLES = {
    Users: {
        key: 'UserId',
        cols: ['UserId', 'Account', 'Name', 'PasswordHash', 'Permissions', 'Strategy', 'IsActive',
            'MustChangePassword', 'Note', 'CreatedAt', 'UpdatedAt', 'LastLoginAt']
    },
    Sessions: {
        key: 'SessionId',
        cols: ['SessionId', 'TokenHash', 'UserId', 'Account', 'Name', 'Device', 'UserAgent', 'LoginAt', 'LastActiveAt']
    },
    LoginLog: {
        key: 'ID',
        cols: ['ID', 'LoginAt', 'UserId', 'Account', 'Name', 'Result', 'Device', 'UserAgent', 'Ip',
            'LastActiveAt', 'EndAt', 'EndReason']
    },
    // 使用者回饋：AI 回答的 👍／👎／📝回報，與「🛠 回報網站」
    Feedback: {
        key: 'ID',
        cols: ['ID', 'Date', 'At', 'Rating', 'Status', 'Confirm', 'Account', 'Name', 'Reason', 'Question', 'Answer',
            'ResolveNote', 'ResolvedAt', 'ConfirmedBy', 'ConfirmedAt', 'AdminNote', 'Symbol', 'Page', 'Model', 'UserId', 'AtUtc']
    },
    // 每個帳號的關注清單與庫存（一檔股票一列）
    Holdings: {
        key: 'ID',
        cols: ['ID', 'Account', 'UserName', 'Market', 'Symbol', 'StockName', 'HoldStatus', 'Shares', 'CostBasis', 'BuyDate',
            'SalesCount', 'UpdatedAt', 'BuyDateSrc', 'Order', 'Sales', 'UserId']
    },
    // 參考指標、策略庫、模擬倉（每個帳號自己的）
    Indicators: { key: 'ID', cols: ['ID', 'Account', 'Name', 'TypeId', 'Summary', 'Params', 'Note', 'CreatedAt', 'UpdatedAt', 'UserId'] },
    Strategies: { key: 'ID', cols: ['ID', 'Account', 'Name', 'Mode', 'Summary', 'Config', 'Note', 'CreatedAt', 'UpdatedAt', 'UserId'] },
    Sims: {
        key: 'ID',
        cols: ['ID', 'Account', 'Name', 'StrategyId', 'Universe', 'MarketTopN', 'InitialCash', 'Cash', 'Equity', 'ReturnPct',
            'AutoTrade', 'LastRunDay', 'LastRunNote', 'Symbols', 'Positions', 'CreatedAt', 'UpdatedAt', 'UserId']
    },
    SimTrades: {
        key: 'ID',
        cols: ['ID', 'SimId', 'Account', 'Day', 'At', 'Side', 'Market', 'Symbol', 'Name', 'Shares', 'Price', 'Fee', 'Pnl', 'Source', 'Reason', 'UserId']
    },
    SimNav: { key: 'ID', cols: ['ID', 'SimId', 'Day', 'Equity', 'Cash', 'IndexClose', 'UserId'] }
};

// 背景紀錄類的表（寫入用獨立的文件鎖，不跟登入搶）
const BACKGROUND_TABLES = { RatingLog: 1, RatingConfirm: 1, Learning: 1, SimPortfolio: 1, BriefArchive: 1, ModelStats: 1, VolumeHistory: 1 };

// 之後新增的資料表不必再改這支程式：名稱符合規則就接受，主鍵一律 ID、欄位依寫入資料自動建立
const GENERIC_TABLE_NAME = /^[A-Z][A-Za-z0-9]{2,40}$/;

function tableDef_(name) {
    if (TABLES[name]) return TABLES[name];
    if (GENERIC_TABLE_NAME.test(name)) return { key: 'ID', cols: ['ID'] };
    return null;
}

// 表頭的中文說明（滑鼠移到表頭上會顯示）
const COLUMN_NOTES = {
    UserId: '帳號內部編號（程式使用，請勿修改）',
    Account: '登入帳號',
    Name: '顯示名稱',
    PasswordHash: '密碼雜湊（不是密碼本身，無法還原）',
    Permissions: '權限代碼，逗號分隔（例如 30,31,32）；代碼說明見網站「帳號與權限」頁',
    Strategy: '投資策略代碼',
    IsActive: 'TRUE＝啟用；FALSE＝停用（停用後下一次操作就會被登出）',
    MustChangePassword: 'TRUE＝下次登入必須先改密碼（臨時密碼）',
    TokenHash: '登入憑證的雜湊（刪除整列＝讓該裝置立即登出）',
    LastActiveAt: '最後活動時間（約每 5 分鐘更新一次）',
    EndReason: '結束原因：登出／強制登出／帳號停用…',
    Rating: 'up＝👍、down＝👎、report＝📝回報、site＝🛠回報網站',
    Reason: '使用者寫的原因／回報內容',
    AtUtc: '回報時間（UTC，給檢查腳本比對用）',
    Date: '回報日期（台北）',
    At: '回報時間（台北）',
    Status: '處理狀態：待處理／已完成（程式已修改）／不處理',
    Confirm: '管理員確認：未確認／已確認／需重改（退回重改時狀態會回到待處理）',
    ResolveNote: '處理說明（改了什麼、commit）',
    AdminNote: '管理員備註（退回重改的原因等）',
    ApprovalStatus: '已核准／待審核（自行申請）／已拒絕；空白＝已核准',
    Contact: '申請帳號時留的聯絡方式，忘記密碼時確認本人用',
    ResetRequestedAt: '使用者申請重設密碼的時間；管理員重設後清空',
    HoldStatus: '持有中／關注／已賣出',
    Shares: '持有股數（股，不是張）',
    CostBasis: '平均成本（每股）',
    Sales: '賣出紀錄（JSON，網站自動維護，請勿手動修改）',
    TypeId: '指標類型（程式代碼）',
    Params: '指標參數（JSON，請在網站修改）',
    Config: '策略設定（JSON，請在網站修改）',
    Mode: 'rules＝條件式；score＝加權計分',
    Universe: 'list＝自選清單；market＝全市場成交量前 N 名',
    Positions: '目前持股（JSON，網站自動維護）',
    Side: 'buy＝買進；sell＝賣出',
    Source: 'auto＝依策略自動；manual＝手動下單',
    Pnl: '賣出的已實現損益（已扣手續費、證交稅）'
};

// ============================================================
// 進入點
// ============================================================
// 協定版本：2＝寫入結果會依 reqId 暫存 10 分鐘（見 doPost）。Next.js 看到 v>=2 才敢在結果遺失時重送寫入。
const GAS_PROTOCOL = 2;
const REPLAY_TTL_SEC = 600;
const REPLAY_MAX_CHARS = 90000;

function doGet() {
    return json_({ success: true, data: 'StockRadar 帳號資料庫運作中', v: GAS_PROTOCOL });
}

/**
 * 寫入結果暫存：Google 回傳結果的網址只能讀一次，讀失敗（404、逾時）後再讀只會拿到 doGet 的回應，
 * 那筆寫入其實已經執行了。Next.js 每個請求帶一個 reqId，結果遺失時用同一個 reqId 重送，
 * 這裡直接回上次的結果、不會重複執行（2026-10-08 使用者操作時看到「格式不正確（回應開頭：StockRadar 帳號資料庫運作中）」）。
 */
function replayKey_(reqId) {
    return 'r:' + reqId;
}
function replayGet_(reqId) {
    try {
        return CacheService.getScriptCache().get(replayKey_(reqId));
    } catch (err) {
        return null;
    }
}
function replayPut_(reqId, text) {
    if (text.length > REPLAY_MAX_CHARS) return;
    try {
        CacheService.getScriptCache().put(replayKey_(reqId), text, REPLAY_TTL_SEC);
    } catch (err) {
        // 暫存失敗不影響這次寫入
    }
}

function doPost(e) {
    let req;
    try {
        req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
        return json_({ success: false, message: '請求格式錯誤' });
    }

    const secret = PropertiesService.getScriptProperties().getProperty('API_SECRET');
    if (!secret || String(req.secret || '') !== secret)
        return json_({ success: false, message: '驗證失敗', code: 'AUTH' });

    const ops = Array.isArray(req.ops) ? req.ops : [];
    if (!ops.length || ops.length > 300) return json_({ success: false, message: '操作數量錯誤' });

    // 只有寫入需要排隊；純讀取不拿鎖，不必等別人的寫入完成。
    // 背景紀錄（評等紀錄、模型統計…）用「文件鎖」，帳號／登入／策略等用「程式鎖」：兩把鎖互相獨立，
    // 背景紀錄一次湧入很多寫入時，不會讓登入排不到鎖（2026-10-08 實際發生 Lock timeout）。
    const readOnly = ops.every(op => op.op === 'read' || op.op === 'readKeys');
    const reqId = /^[A-Za-z0-9_-]{8,64}$/.test(String(req.reqId || '')) ? String(req.reqId) : '';
    const background = ops.every(op => BACKGROUND_TABLES[String(op.table)]);
    const lock = readOnly ? null : background ? LockService.getDocumentLock() : LockService.getScriptLock();
    try {
        if (lock) lock.waitLock(20000);
        // 拿到鎖之後才查暫存：原本那次還在執行時，重送的請求會排在它後面，之後直接拿到它的結果
        if (reqId && !readOnly) {
            const hit = replayGet_(reqId);
            if (hit) return raw_(hit);
        }
        const results = ops.map(runOp_);
        if (!readOnly) SpreadsheetApp.flush();
        const out = JSON.stringify({ success: true, data: results, v: GAS_PROTOCOL });
        if (reqId && !readOnly) replayPut_(reqId, out);
        return raw_(out);
    } catch (err) {
        console.error(err && err.stack ? err.stack : err);
        return json_({ success: false, message: '系統錯誤：' + (err && err.message ? err.message : err) });
    } finally {
        if (lock) lock.releaseLock();
    }
}

function runOp_(op) {
    const name = String(op.table || '');
    const def = tableDef_(name);
    if (!def) throw new Error('未知的資料表：' + name);
    const sheet = sheet_(name);

    switch (op.op) {
        case 'read':
            return readRows_(sheet).map(r => r.obj);
        case 'append':
            appendRow_(sheet, op.row || {});
            return true;
        case 'update': {
            const found = findRow_(sheet, def.key, op.key);
            if (!found) return false;
            writeRow_(sheet, found.row, op.patch || {});
            return true;
        }
        case 'delete': {
            const found = findRow_(sheet, def.key, op.key);
            if (!found) return false;
            sheet.deleteRow(found.row);
            return true;
        }
        case 'replaceWhere': {
            // 把 col＝value 的所有列換成 op.rows（例如某個帳號的整份關注清單），整張表一次寫回
            const newRows = Array.isArray(op.rows) ? op.rows : [];
            let headers = headers_(sheet);
            newRows.forEach(r => { headers = ensureCols_(sheet, Object.keys(r)); });
            const col = headers.indexOf(String(op.col));
            if (col < 0) throw new Error('未知的欄位：' + op.col);
            const last = sheet.getLastRow();
            const old = last >= 2 ? sheet.getRange(2, 1, last - 1, headers.length).getValues() : [];
            const kept = old.filter(r => String(r[col]) !== String(op.value));
            const added = newRows.map(r => headers.map(h => (r[h] == null ? '' : String(r[h]))));
            const all = kept.concat(added);
            if (last >= 2) sheet.getRange(2, 1, last - 1, headers.length).clearContent();
            if (all.length) sheet.getRange(2, 1, all.length, headers.length).setNumberFormat('@').setValues(all);
            return true;
        }
        case 'readKeys': {
            // 只回傳 col 欄位值在 values 裡的列（在 Google 端篩選，不必把整張表傳回去）
            const want = {};
            (Array.isArray(op.values) ? op.values : []).forEach(v => { want[String(v)] = true; });
            const col = String(op.col || def.key);
            return readRows_(sheet).filter(r => want[String(r.obj[col])]).map(r => r.obj);
        }
        case 'upsert': {
            // 依主鍵批次新增或更新：已存在的列整列覆蓋指定欄位，新的列一次附加在最下面
            const rows = Array.isArray(op.rows) ? op.rows : [];
            if (!rows.length) return 0;
            let headers = headers_(sheet);
            rows.forEach(r => { headers = ensureCols_(sheet, Object.keys(r)); });
            const keyIdx = headers.indexOf(def.key);
            const last = sheet.getLastRow();
            const index = {};
            if (last >= 2) sheet.getRange(2, keyIdx + 1, last - 1, 1).getDisplayValues().forEach((v, i) => { index[String(v[0])] = i + 2; });
            const appends = [];
            rows.forEach(r => {
                const rowNum = index[String(r[def.key])];
                if (rowNum) writeRow_(sheet, rowNum, r);
                else appends.push(headers.map(h => (r[h] == null ? '' : String(r[h]))));
            });
            if (appends.length) {
                const start = sheet.getLastRow() + 1;
                sheet.getRange(start, 1, appends.length, headers.length).setNumberFormat('@').setValues(appends);
            }
            return rows.length;
        }
        case 'deleteWhere': {
            // 刪除 col 欄位值在 values 裡的所有列（由下往上刪，列號才不會跑掉）
            const want = {};
            (Array.isArray(op.values) ? op.values : []).forEach(v => { want[String(v)] = true; });
            const col = String(op.col || def.key);
            const hit = readRows_(sheet).filter(r => want[String(r.obj[col])]).map(r => r.row).sort((a, b) => b - a);
            hit.forEach(row => sheet.deleteRow(row));
            return hit.length;
        }
        case 'trim': {
            // 只保留最新 keep 筆（資料由舊到新附加在下方）
            const keep = Math.max(50, Number(op.keep) || 0);
            const dataRows = sheet.getLastRow() - 1;
            if (dataRows > keep) sheet.deleteRows(2, dataRows - keep);
            return true;
        }
        default:
            throw new Error('未知的操作：' + op.op);
    }
}

// ============================================================
// 初始化：在編輯器選擇 setup 執行一次
// ============================================================
function setup() {
    Object.keys(TABLES).forEach(name => {
        const sheet = sheet_(name);
        ensureCols_(sheet, TABLES[name].cols);
        sheet.setFrozenRows(1);
        const header = sheet.getRange(1, 1, 1, sheet.getLastColumn());
        header.setFontWeight('bold').setBackground('#e8eaed');
        header.getValues()[0].forEach((h, i) => {
            if (COLUMN_NOTES[h]) sheet.getRange(1, i + 1).setNote(COLUMN_NOTES[h]);
        });
    });

    // 刪掉新試算表預設的空白「工作表1」
    const ss = SpreadsheetApp.getActive();
    ss.getSheets().forEach(s => {
        if (!TABLES[s.getName()] && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
    });

    const props = PropertiesService.getScriptProperties();
    let secret = props.getProperty('API_SECRET');
    if (!secret) {
        secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
        props.setProperty('API_SECRET', secret);
    }
    console.log('初始化完成。API_SECRET（設定到 Vercel / .env.local 的 AUTH_GAS_SECRET）：' + secret);
}

// ============================================================
// 試算表工具
// ============================================================
function sheet_(name) {
    const ss = SpreadsheetApp.getActive();
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
        sheet = ss.insertSheet(name);
        // 全部以純文字儲存，避免帳號「0050」被轉成數字、時間被轉成日期
        sheet.getRange('A:Z').setNumberFormat('@');
        ensureCols_(sheet, tableDef_(name).cols);
    }
    return sheet;
}

function headers_(sheet) {
    const lastCol = sheet.getLastColumn();
    if (!lastCol) return [];
    return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
}

// 補上缺少的欄位（加在最右邊），回傳最新表頭
function ensureCols_(sheet, cols) {
    const headers = headers_(sheet);
    const missing = cols.filter(c => headers.indexOf(c) < 0);
    if (missing.length) {
        const start = headers.length + 1;
        if (sheet.getMaxColumns() < start + missing.length - 1)
            sheet.insertColumnsAfter(sheet.getMaxColumns(), start + missing.length - 1 - sheet.getMaxColumns());
        sheet.getRange(1, start, 1, missing.length).setValues([missing]).setNumberFormat('@');
        sheet.getRange(2, start, Math.max(1, sheet.getMaxRows() - 1), missing.length).setNumberFormat('@');
    }
    return headers.concat(missing);
}

function readRows_(sheet) {
    const headers = headers_(sheet);
    const last = sheet.getLastRow();
    if (last < 2 || !headers.length) return [];
    return sheet.getRange(2, 1, last - 1, headers.length).getDisplayValues().map((r, i) => {
        const obj = {};
        headers.forEach((h, j) => { if (h) obj[h] = r[j]; });
        return { row: i + 2, obj };
    });
}

function findRow_(sheet, key, value) {
    value = String(value == null ? '' : value);
    if (!value) return null;
    return readRows_(sheet).find(r => String(r.obj[key]) === value) || null;
}

function appendRow_(sheet, row) {
    const headers = ensureCols_(sheet, Object.keys(row));
    sheet.appendRow(headers.map(h => (row[h] == null ? '' : String(row[h]))));
}

function writeRow_(sheet, rowNum, patch) {
    const headers = ensureCols_(sheet, Object.keys(patch));
    const range = sheet.getRange(rowNum, 1, 1, headers.length);
    const values = range.getValues()[0];
    headers.forEach((h, i) => {
        if (Object.prototype.hasOwnProperty.call(patch, h)) values[i] = patch[h] == null ? '' : String(patch[h]);
    });
    range.setValues([values]);
}

function raw_(text) {
    return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function json_(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
