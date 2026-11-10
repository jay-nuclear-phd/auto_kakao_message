/**
 * 3반 결강 현황 – 데이터 저장용 Google Apps Script 웹앱
 *
 * 구글 시트에 붙여서 배포한다:
 *   시트 열기 → 확장 프로그램 → Apps Script → 이 코드 붙여넣기 → 저장
 *   → 배포 → 새 배포 → 유형: 웹 앱, 실행: 나, 액세스: 모든 사용자 → 배포
 *   → 나오는 웹 앱 URL(.../exec)을 docs/index.html 의 CONFIG.API_URL 에 넣는다.
 *
 * 시트 구성(없으면 자동 생성):
 *   entries: date | name | status | reason | start | end | updatedAt
 *   config : key | value   (reasons: JSON 배열, total: 총원)
 */

const ENTRY_COLS = ['date', 'name', 'status', 'reason', 'start', 'end', 'updatedAt'];

function doGet(e) {
  try {
    const p = e.parameter || {};
    if (p.action === 'list') {
      return json({ ok: true, entries: listEntries(p.from, p.to), config: getConfig() });
    }
    return json({ ok: true, config: getConfig() });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const b = JSON.parse(e.postData.contents);
    switch (b.action) {
      case 'upsert': upsert(b.entry); break;
      case 'remove': removeEntry(b.date, b.name); break;
      case 'addReason': addReason(b.reason); break;
      case 'setTotal': setConfig('total', String(Number(b.total))); break;
      default: throw new Error('unknown action: ' + b.action);
    }
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- entries ---------- */
function entriesSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('entries');
  if (!sh) {
    sh = ss.insertSheet('entries');
    sh.getRange(1, 1, 1, ENTRY_COLS.length).setValues([ENTRY_COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  // 날짜·시간 문자열이 자동으로 날짜형으로 바뀌지 않게 일반 텍스트로 고정
  sh.getRange('A:G').setNumberFormat('@');
  return sh;
}

function cellStr(v, kind) {
  if (v instanceof Date) {
    const tz = Session.getScriptTimeZone();
    return Utilities.formatDate(v, tz, kind === 'time' ? 'HH:mm' : 'yyyy-MM-dd');
  }
  return String(v === null || v === undefined ? '' : v);
}

function readAll(sh) {
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, ENTRY_COLS.length).getValues().map(function (r, i) {
    return {
      row: i + 2,
      date: cellStr(r[0], 'date'), name: cellStr(r[1]), status: cellStr(r[2]), reason: cellStr(r[3]),
      start: cellStr(r[4], 'time'), end: cellStr(r[5], 'time'), updatedAt: cellStr(r[6]),
    };
  });
}

function listEntries(from, to) {
  return readAll(entriesSheet())
    .filter(function (e) { return (!from || e.date >= from) && (!to || e.date <= to); })
    .map(function (e) { delete e.row; return e; });
}

function validateEntry(x) {
  if (!x || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) throw new Error('잘못된 날짜');
  if (!x.name || String(x.name).length > 40) throw new Error('잘못된 이름');
  if (x.status !== 'none' && x.status !== 'absent') throw new Error('잘못된 상태');
  if (x.status === 'absent') {
    if (!/^\d{2}:\d{2}$/.test(x.start) || !/^\d{2}:\d{2}$/.test(x.end) || x.start >= x.end) throw new Error('잘못된 시간');
    if (!x.reason || String(x.reason).length > 30) throw new Error('잘못된 사유');
  }
}

function upsert(x) {
  validateEntry(x);
  const sh = entriesSheet();
  const row = [x.date, x.name, x.status, x.reason || '', x.start || '', x.end || '', new Date().toISOString()];
  const hit = readAll(sh).find(function (e) { return e.date === x.date && e.name === x.name; });
  if (hit) sh.getRange(hit.row, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

function removeEntry(date, name) {
  const sh = entriesSheet();
  const hits = readAll(sh).filter(function (e) { return e.date === date && e.name === name; });
  hits.reverse().forEach(function (e) { sh.deleteRow(e.row); });
}

/* ---------- config ---------- */
function configSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('config');
  if (!sh) {
    sh = ss.insertSheet('config');
    sh.getRange(1, 1, 3, 2).setValues([['key', 'value'], ['reasons', '[]'], ['total', '45']]);
    sh.getRange('B:B').setNumberFormat('@');
  }
  return sh;
}

function getConfig() {
  const rows = configSheet().getDataRange().getValues();
  const cfg = {};
  rows.slice(1).forEach(function (r) { cfg[r[0]] = r[1]; });
  let reasons = [];
  try { reasons = JSON.parse(cfg.reasons || '[]'); } catch (e) {}
  return { reasons: reasons, total: Number(cfg.total) || 45 };
}

function setConfig(key, value) {
  const sh = configSheet();
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) { sh.getRange(i + 1, 2).setValue(value); return; }
  }
  sh.appendRow([key, value]);
}

function addReason(r) {
  if (!r || !r.name || String(r.name).length > 30) throw new Error('잘못된 사유');
  if (r.type !== 'leave' && r.type !== 'time') throw new Error('잘못된 사유 유형');
  const reasons = getConfig().reasons;
  if (!reasons.some(function (x) { return x.name === r.name; })) {
    reasons.push({ name: String(r.name), type: r.type });
    setConfig('reasons', JSON.stringify(reasons));
  }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
