/**
 * 3반 결강 현황 – 데이터 저장용 Google Apps Script 웹앱
 *
 * 설치:
 *   1) Apps Script 편집기에서 Code.gs 내용을 전부 이 코드로 바꾸고 저장
 *   2) 위쪽 함수 선택에서 setup 을 골라 ▶실행 → 권한 허용 (데이터 시트가 생성되고 로그에 주소가 나옴)
 *   3) 배포 → 배포 관리 → (기존 배포) 연필 아이콘 → 버전: "새 버전" → 배포
 *      (새 버전으로 다시 배포해야 같은 /exec URL에 새 코드가 반영된다)
 *   웹앱 설정: 실행 사용자 = 나, 액세스 권한 = 모든 사용자
 *
 * 시트에 붙인 스크립트면 그 시트를, 단독 스크립트면 setup 때 새로 만든 시트를 쓴다.
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

/* ---------- spreadsheet ---------- */
function getSpreadsheet() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('3반 결강 현황 데이터');
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

/** 편집기에서 한 번 실행: 권한 승인 + 시트 생성 */
function setup() {
  const ss = getSpreadsheet();
  entriesSheet();
  configSheet();
  const first = ss.getSheets()[0];
  if (ss.getSheets().length > 2 && first.getName() !== 'entries' && first.getLastRow() === 0) ss.deleteSheet(first);
  Logger.log('데이터 시트: ' + ss.getUrl());
}

/* ---------- entries ---------- */
function entriesSheet() {
  const ss = getSpreadsheet();
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
  if (kind === 'time' && typeof v === 'string') {
    const m = v.match(/^(\d{1,2}):(\d{2})/);
    return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : v;
  }
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
  // 앞에 ' 를 붙여 시트가 날짜/시간으로 자동 변환하지 않게 텍스트로 저장
  const row = ["'" + x.date, x.name, x.status, x.reason || '', x.start ? "'" + x.start : '', x.end ? "'" + x.end : '', new Date().toISOString()];
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
  const ss = getSpreadsheet();
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
