// ============================================================
// 股情雷達 帳號資料庫（Google Apps Script，綁在 Google 試算表上）
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
    }
};

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
    EndReason: '結束原因：登出／強制登出／帳號停用…'
};

// ============================================================
// 進入點
// ============================================================
function doGet() {
    return json_({ success: true, data: 'StockRadar 帳號資料庫運作中' });
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
    if (!ops.length || ops.length > 50) return json_({ success: false, message: '操作數量錯誤' });

    const lock = LockService.getScriptLock();
    try {
        lock.waitLock(20000);
        const results = ops.map(runOp_);
        SpreadsheetApp.flush();
        return json_({ success: true, data: results });
    } catch (err) {
        console.error(err && err.stack ? err.stack : err);
        return json_({ success: false, message: '系統錯誤：' + (err && err.message ? err.message : err) });
    } finally {
        lock.releaseLock();
    }
}

function runOp_(op) {
    const name = String(op.table || '');
    if (!TABLES[name]) throw new Error('未知的資料表：' + name);
    const sheet = sheet_(name);

    switch (op.op) {
        case 'read':
            return readRows_(sheet).map(r => r.obj);
        case 'append':
            appendRow_(sheet, op.row || {});
            return true;
        case 'update': {
            const found = findRow_(sheet, TABLES[name].key, op.key);
            if (!found) return false;
            writeRow_(sheet, found.row, op.patch || {});
            return true;
        }
        case 'delete': {
            const found = findRow_(sheet, TABLES[name].key, op.key);
            if (!found) return false;
            sheet.deleteRow(found.row);
            return true;
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
        ensureCols_(sheet, TABLES[name].cols);
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

function json_(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
