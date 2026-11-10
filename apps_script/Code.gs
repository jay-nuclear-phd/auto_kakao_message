/**
 * 3반 결강 현황 – 데이터 저장용 Google Apps Script 웹앱
 *
 * 설치/업데이트:
 *   1) Apps Script 편집기에서 Code.gs 내용을 전부 이 코드로 바꾸고 저장
 *   2) 프로젝트 설정(톱니바퀴) → 스크립트 속성 → 속성 추가
 *        ADMIN_ID = 관리자 아이디,  ADMIN_PW = 관리자 비밀번호
 *      (비밀번호는 공개 저장소에 올라가지 않도록 코드가 아니라 여기에만 둔다)
 *   3) 함수 선택에서 setup 을 골라 ▶실행 → 권한 허용 (처음 한 번)
 *   4) 배포 → 배포 관리 → 기존 배포 연필 아이콘 → 버전: "새 버전" → 배포
 *      (새 버전으로 다시 배포해야 같은 /exec URL에 새 코드가 반영된다)
 *   웹앱 설정: 실행 사용자 = 나, 액세스 권한 = 모든 사용자
 *
 * 규칙:
 *   - 누구나: 지금 조사 중인 날짜(정오 전=오늘, 정오 후=다음 평일, 한국 시간)에 자기 입력 저장/삭제
 *   - 관리자만: 다른 날짜 저장/삭제, 총원 변경
 *
 * 시트 구성(없으면 자동 생성):
 *   entries: date | name | status | reason | times | updatedAt
 *            times 예: "08:00~08:30,15:30~17:30"
 *   config : key | value   (reasons: JSON 배열, total: 총원)
 */

const ENTRY_COLS = ['date', 'name', 'status', 'reason', 'times', 'updatedAt'];
const TZ = 'Asia/Seoul';

function doGet(e) {
  try {
    const p = e.parameter || {};
    if (p.action === 'list') {
      return json({ ok: true, entries: listEntries(p.from, p.to), config: getConfig() });
    }
    return json({ ok: true, config: getConfig() });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const b = JSON.parse(e.postData.contents);
    switch (b.action) {
      case 'login':
        if (!isAdmin(b.auth)) throw new Error('아이디 또는 비밀번호가 틀렸습니다');
        break;
      case 'upsert':
        requireOpenOrAdmin(b.entry && b.entry.date, b.auth);
        upsert(b.entry);
        break;
      case 'remove':
        requireOpenOrAdmin(b.date, b.auth);
        removeEntry(b.date, b.name);
        break;
      case 'addReason':
        addReason(b.reason);
        break;
      case 'setTotal':
        if (!isAdmin(b.auth)) throw new Error('관리자 로그인이 필요합니다');
        setConfig('total', String(Number(b.total)));
        break;
      default:
        throw new Error('unknown action: ' + b.action);
    }
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 권한 ---------- */
function isAdmin(auth) {
  const props = PropertiesService.getScriptProperties();
  const pw = props.getProperty('ADMIN_PW');
  const id = props.getProperty('ADMIN_ID') || 'admin';
  if (!pw) throw new Error('서버에 관리자 비밀번호(ADMIN_PW)가 설정되지 않았습니다');
  return !!auth && auth.id === id && auth.pw === pw;
}

// 한국 시간 기준 조사 중인 날짜. 정오 전후로 화면과 몇 분 어긋날 수 있어 ±10분 모두 허용.
function openDates() {
  const now = Date.now();
  return [now - 600000, now, now + 600000].map(function (t) { return surveyDate(new Date(t)); });
}
function surveyDate(d) {
  const parts = Utilities.formatDate(d, TZ, 'yyyy-MM-dd-HH').split('-').map(Number);
  const day = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (parts[3] >= 12) day.setUTCDate(day.getUTCDate() + 1);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
  return Utilities.formatDate(day, 'UTC', 'yyyy-MM-dd');
}
function requireOpenOrAdmin(date, auth) {
  if (openDates().indexOf(date) >= 0) return;
  if (!isAdmin(auth)) throw new Error('조사 중인 날짜가 아니라서 관리자 로그인이 필요합니다');
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
  Logger.log('데이터 시트: ' + ss.getUrl());
}

/* ---------- entries ---------- */
function entriesSheet() {
  const ss = getSpreadsheet();
  let sh = ss.getSheetByName('entries');
  if (!sh) sh = ss.insertSheet('entries');
  const head = sh.getRange(1, 1, 1, ENTRY_COLS.length).getDisplayValues()[0];
  if (head.join('|') !== ENTRY_COLS.join('|')) {
    sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), ENTRY_COLS.length)).clearContent();
    sh.getRange(1, 1, 1, ENTRY_COLS.length).setValues([ENTRY_COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll(sh) {
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, ENTRY_COLS.length).getDisplayValues().map(function (r, i) {
    return { row: i + 2, date: r[0], name: r[1], status: r[2], reason: r[3], times: r[4], updatedAt: r[5] };
  });
}

function listEntries(from, to) {
  return readAll(entriesSheet())
    .filter(function (e) { return (!from || e.date >= from) && (!to || e.date <= to); })
    .map(function (e) { delete e.row; return e; });
}

const TIMES_RE = /^\d{2}:\d{2}~\d{2}:\d{2}(,\d{2}:\d{2}~\d{2}:\d{2})*$/;
function validateEntry(x) {
  if (!x || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) throw new Error('잘못된 날짜');
  if (!x.name || String(x.name).length > 40) throw new Error('잘못된 이름');
  if (x.status !== 'none' && x.status !== 'absent') throw new Error('잘못된 상태');
  if (x.status === 'absent') {
    if (!TIMES_RE.test(x.times || '')) throw new Error('잘못된 시간');
    x.times.split(',').forEach(function (r) {
      const se = r.split('~');
      if (!(se[0] >= '08:00' && se[1] <= '17:30' && se[0] < se[1])) throw new Error('잘못된 시간: ' + r);
    });
    if (!x.reason || String(x.reason).length > 30) throw new Error('잘못된 사유');
  }
}

function upsert(x) {
  validateEntry(x);
  const sh = entriesSheet();
  // 앞에 ' 를 붙여 시트가 날짜/시간으로 자동 변환하지 않게 텍스트로 저장
  const row = ["'" + x.date, x.name, x.status, x.reason || '', x.times ? "'" + x.times : '', new Date().toISOString()];
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
    sh.getRange('B:B').setNumberFormat('@');
    sh.getRange(1, 1, 3, 2).setValues([['key', 'value'], ['reasons', '[]'], ['total', '45']]);
  }
  return sh;
}

function getConfig() {
  const rows = configSheet().getDataRange().getDisplayValues();
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
