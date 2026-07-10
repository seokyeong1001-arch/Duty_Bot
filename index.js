const { App } = require('@slack/bolt');
const cron = require('node-cron');
const { google } = require('googleapis');

// ─── Railway 환경변수 API ──────────────────────────────
function railwayHeaders() {
  return {
    'Authorization': `Bearer ${process.env.RAILWAY_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function railwayIds() {
  return {
    projectId: process.env.RAILWAY_PROJECT_ID,
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
    serviceId: process.env.RAILWAY_SERVICE_ID,
  };
}

function hasRailwayCreds() {
  const { projectId, environmentId, serviceId } = railwayIds();
  return !!(process.env.RAILWAY_API_TOKEN && projectId && environmentId && serviceId);
}

async function getThreadTs() {
  if (!hasRailwayCreds()) return null;
  const { projectId, environmentId, serviceId } = railwayIds();
  const res = await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST',
    headers: railwayHeaders(),
    body: JSON.stringify({
      query: `
        query Variables($projectId: String!, $environmentId: String!, $serviceId: String!) {
          variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
        }
      `,
      variables: { projectId, environmentId, serviceId },
    }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data.variables?.WEEKLY_THREAD_TS || null;
}

async function setThreadTs(ts) {
  if (!hasRailwayCreds()) return;
  const { projectId, environmentId, serviceId } = railwayIds();
  const res = await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST',
    headers: railwayHeaders(),
    body: JSON.stringify({
      query: `
        mutation VariableUpsert($input: VariableUpsertInput!) {
          variableUpsert(input: $input)
        }
      `,
      variables: {
        input: { projectId, environmentId, serviceId, name: 'WEEKLY_THREAD_TS', value: ts },
      },
    }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
}

// ─── Google Sheets CSV ────────────────────────────────
const SHEET_ID = '1AJ297G3fIa_P4qcF1vrC3aTsJNjC6baKvsmSrD1Wh_4';
const sheetUrl = (tab) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;

// ─── 영구 저장 탭 ─────────────────────────────────────
const OVERRIDE_TAB = '변경'; // 날짜 | 메인 | 크첵
const LEAVE_TAB = '연차';    // 이름 | 시작일 | 종료일
// 최초 탭 생성 시 이관할 기존 변경값 (메모리 → 시트 1회성 시드)
const SEED_OVERRIDES = [
  { date: '2026-07-14', main: '손유곤', check: '문선정' },
];

function parseLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { current += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { result.push(current); current = ''; }
      else { current += c; }
    }
  }
  result.push(current);
  return result;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = parseLine(lines[0]).map(h => h.trim());
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = parseLine(line);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
      return obj;
    });
}

// ─── 시트 캐시 ────────────────────────────────────────
let sheetCache = { members: {}, loop: [], checkLoop: [], startDate: '' };

async function loadSheets() {
  try {
    const [memberRes, loopRes, checkRes] = await Promise.all([
      fetch(sheetUrl('멤버')),
      fetch(sheetUrl('루프')),
      fetch(sheetUrl('크첵루프')),
    ]);
    const [memberText, loopText, checkText] = await Promise.all([
      memberRes.text(), loopRes.text(), checkRes.text(),
    ]);

    const memberRows = parseCSV(memberText);
    const loopRows   = parseCSV(loopText);
    const checkRows  = parseCSV(checkText);

    const members = {};
    for (const row of memberRows) {
      if (row['이름']) members[row['이름']] = row['슬랙ID'] || '';
    }

    sheetCache = {
      members,
      startDate: loopRows[0]?.['시작일'] || '',
      loop: loopRows.map(r => ({ main: r['메인'], needCheck: r['크첵필요'] === 'O' })),
      checkLoop: checkRows.map(r => ({ check: r['크첵'] })),
    };

    console.log(
      `[시트 캐시] 갱신 완료 — 멤버 ${Object.keys(members).length}명 / ` +
      `루프 ${sheetCache.loop.length}칸 / 크첵루프 ${sheetCache.checkLoop.length}칸 / ` +
      `시작일 ${sheetCache.startDate}`
    );
  } catch (e) {
    console.error('[시트 캐시] 로드 실패:', e.message);
  }
}

// ─── Google Sheets 쓰기 (googleapis) ──────────────────
let sheetsClient = null;
let tabSheetIds = {}; // 탭 제목 → 숫자 sheetId

function hasSheetsCreds() {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
}

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// 여러 포맷의 날짜 문자열 → 'YYYY-MM-DD'
function normalizeDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/^(\d{4})[-.\s/]+(\d{1,2})[-.\s/]+(\d{1,2})/); // 2026-07-14, 2026. 7. 14
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/); // 7/14/2026
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function expandRange(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  const dates = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toLocaleDateString('sv-SE'));
  }
  return dates;
}

// 두 탭이 없으면 생성하고 헤더/시드 보장, sheetId 매핑 저장
async function ensureTabs() {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const bySheet = {};
  for (const s of meta.data.sheets) bySheet[s.properties.title] = s.properties.sheetId;

  const created = [];
  const requests = [];
  for (const title of [OVERRIDE_TAB, LEAVE_TAB]) {
    if (!(title in bySheet)) { requests.push({ addSheet: { properties: { title } } }); created.push(title); }
  }
  if (requests.length) {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID, requestBody: { requests },
    });
    for (const r of res.data.replies) {
      if (r.addSheet) bySheet[r.addSheet.properties.title] = r.addSheet.properties.sheetId;
    }
  }
  tabSheetIds = bySheet;

  await ensureHeader(OVERRIDE_TAB, ['날짜', '메인', '크첵']);
  await ensureHeader(LEAVE_TAB, ['이름', '시작일', '종료일']);

  // 변경 탭을 이번에 새로 만든 경우에만 기존 메모리 값 시드
  if (created.includes(OVERRIDE_TAB) && SEED_OVERRIDES.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${OVERRIDE_TAB}!A1`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: SEED_OVERRIDES.map(o => [o.date, o.main, o.check || '']) },
    });
    console.log(`[영구저장] 변경 탭 생성 + 시드 ${SEED_OVERRIDES.length}건 입력`);
  }
}

async function ensureHeader(tab, header) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:C1` });
  const row = (res.data.values && res.data.values[0]) || [];
  if (row.join('|') !== header.join('|')) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${tab}!A1`, valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  }
}

// 특정 탭 날짜(A열) 기준 데이터 행 인덱스(헤더 제외, 0-based). 없으면 -1
async function findRowIndexByDate(tab, matchDate) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A2:A` });
  const col = res.data.values || [];
  for (let i = 0; i < col.length; i++) {
    if (normalizeDate(col[i][0]) === matchDate) return i;
  }
  return -1;
}

// 데이터 행 인덱스(헤더 제외, 0-based) 삭제
async function deleteRow(tab, dataRowIdx) {
  const sheets = getSheetsClient();
  const sheetId = tabSheetIds[tab];
  if (sheetId === undefined) return;
  const startIndex = dataRowIdx + 1; // 헤더가 0번, 첫 데이터가 1번
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ deleteDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex, endIndex: startIndex + 1 },
    } }] },
  });
}

// 메모리 overrides 상태를 변경 탭 한 행에 반영 (없으면 삭제)
async function syncOverrideRow(date) {
  if (!hasSheetsCreds()) return;
  try {
    const hasMain = `${date}:main` in overrides;
    const hasCheck = `${date}:check` in overrides;
    if (!hasMain && !hasCheck) {
      const idx = await findRowIndexByDate(OVERRIDE_TAB, date);
      if (idx >= 0) await deleteRow(OVERRIDE_TAB, idx);
      return;
    }
    const sheets = getSheetsClient();
    const values = [[date, overrides[`${date}:main`] || '', overrides[`${date}:check`] || '']];
    const idx = await findRowIndexByDate(OVERRIDE_TAB, date);
    if (idx >= 0) {
      const rowNum = idx + 2; // +1 헤더, +1 1-based
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${OVERRIDE_TAB}!A${rowNum}:C${rowNum}`,
        valueInputOption: 'RAW', requestBody: { values },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${OVERRIDE_TAB}!A1`,
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values },
      });
    }
  } catch (e) {
    console.error('[영구저장] 변경 반영 실패:', e.message);
  }
}

// 연차 탭에 [이름, 시작일, 종료일] 한 행 추가
async function persistLeaveAdd(name, startStr, endStr) {
  if (!hasSheetsCreds()) return;
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${LEAVE_TAB}!A1`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[name, startStr, endStr]] },
    });
  } catch (e) {
    console.error('[영구저장] 연차 등록 실패:', e.message);
  }
}

// 연차 탭에서 이름 일치 + 기간 겹치는 행 삭제
async function persistLeaveRemove(name, startStr, endStr) {
  if (!hasSheetsCreds()) return;
  try {
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${LEAVE_TAB}!A2:C` });
    const rows = res.data.values || [];
    const toDelete = [];
    for (let i = 0; i < rows.length; i++) {
      const [rName, rStart, rEnd] = rows[i];
      if (rName !== name) continue;
      const s = normalizeDate(rStart);
      if (!s) continue;
      const e = normalizeDate(rEnd) || s;
      if (s <= endStr && e >= startStr) toDelete.push(i); // 기간 겹침
    }
    for (const idx of toDelete.sort((a, b) => b - a)) { // 아래 행부터 삭제
      await deleteRow(LEAVE_TAB, idx);
    }
  } catch (e) {
    console.error('[영구저장] 연차 취소 실패:', e.message);
  }
}

// 서버 시작/캐시갱신 시 두 탭을 읽어 메모리에 로드
async function loadPersisted() {
  if (!hasSheetsCreds()) {
    console.warn('[영구저장] GOOGLE_SERVICE_ACCOUNT_JSON 미설정 — 메모리 전용 모드로 동작');
    return;
  }
  try {
    await ensureTabs();
    const sheets = getSheetsClient();

    // 변경
    for (const k of Object.keys(overrides)) delete overrides[k];
    const ov = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${OVERRIDE_TAB}!A2:C` });
    for (const row of (ov.data.values || [])) {
      const date = normalizeDate(row[0]);
      if (!date) continue;
      if (row[1]) overrides[`${date}:main`] = row[1];
      if (row[2]) overrides[`${date}:check`] = row[2];
    }

    // 연차
    for (const k of Object.keys(leaves)) delete leaves[k];
    const lv = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${LEAVE_TAB}!A2:C` });
    for (const row of (lv.data.values || [])) {
      const name = (row[0] || '').trim();
      const start = normalizeDate(row[1]);
      if (!name || !start) continue;
      const end = normalizeDate(row[2]) || start;
      addLeave(name, expandRange(start, end));
    }

    console.log(`[영구저장] 로드 완료 — 변경 ${Object.keys(overrides).length}건 / 연차 ${Object.keys(leaves).length}명`);
  } catch (e) {
    console.error('[영구저장] 로드 실패:', e.message);
  }
}

// ─── 앱 ───────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const CONFIG = {
  notifyChannel: process.env.SLACK_CHANNEL,
  notifyTime: '30 7 * * *',
  weeklyTime: '0 7 * * 1',
  eveningNotifyTime: '0 18 * * *',
};

const overrides = {};
const leaves = {}; // { '이름': Set<'YYYY-MM-DD'> }
let botUserId = null;

// ─── 날짜 유틸 ────────────────────────────────────────
function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function seoulYear() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 4);
}

function parseDate(input) {
  const match = input.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (!match) return null;
  return `${seoulYear()}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

// '07.14~07.16' 또는 '07.14' → ['YYYY-MM-DD', ...]
function parseDateRange(rangeStr) {
  const year = seoulYear();
  const rangeMatch = rangeStr.match(/^(\d{1,2})\.(\d{1,2})~(\d{1,2})\.(\d{1,2})$/);
  if (rangeMatch) {
    const [, m1, d1, m2, d2] = rangeMatch;
    const start = new Date(`${year}-${m1.padStart(2, '0')}-${d1.padStart(2, '0')}`);
    const end   = new Date(`${year}-${m2.padStart(2, '0')}-${d2.padStart(2, '0')}`);
    if (isNaN(start) || isNaN(end) || start > end) return null;
    const dates = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toLocaleDateString('sv-SE'));
    }
    return dates;
  }
  const singleMatch = rangeStr.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (singleMatch) {
    const [, mm, dd] = singleMatch;
    return [`${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`];
  }
  return null;
}

function dateLabel(dateStr) {
  const d = new Date(dateStr);
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const [, mm, dd] = dateStr.split('-');
  return `${mm}.${dd} (${dayNames[d.getDay()]})`;
}

function getWeekLabel(dateStr) {
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;
  const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
  const week = Math.ceil((d.getDate() + firstDay.getDay()) / 7);
  return `${month}월 ${week}주차`;
}

async function getRealName(client, userId) {
  try {
    const res = await client.users.info({ user: userId });
    return res.user.profile.display_name || res.user.profile.real_name || res.user.name;
  } catch {
    return userId;
  }
}

// ─── 연차 유틸 ────────────────────────────────────────
function isOnLeave(name, dateStr) {
  return !!(name && leaves[name] && leaves[name].has(dateStr));
}

function addLeave(name, dates) {
  if (!leaves[name]) leaves[name] = new Set();
  for (const d of dates) leaves[name].add(d);
}

function removeLeave(name, dates) {
  if (!leaves[name]) return 0;
  let count = 0;
  for (const d of dates) { if (leaves[name].delete(d)) count++; }
  if (leaves[name].size === 0) delete leaves[name];
  return count;
}

function leaveListText() {
  const names = Object.keys(leaves).filter(n => leaves[n].size > 0);
  if (!names.length) return 'ℹ️ 등록된 연차가 없어요.';
  const lines = names.map(name => {
    const sorted = [...leaves[name]].sort();
    const dates = sorted.map(dateLabel).join(', ');
    return `• *${name}*: ${dates}`;
  });
  return `📋 *등록된 연차 목록*\n\n${lines.join('\n')}`;
}

// ─── 당번 계산 ────────────────────────────────────────
// 반환: { name: string|null, isSubstitute: boolean }
function dayDiff(dateStr) {
  const start = new Date(sheetCache.startDate);
  const target = new Date(dateStr);
  return Math.round((target - start) / (1000 * 60 * 60 * 24));
}

function getMain(dateStr) {
  if (`${dateStr}:main` in overrides) {
    return { name: overrides[`${dateStr}:main`] || null, isSubstitute: false };
  }
  const { loop, startDate } = sheetCache;
  if (!startDate || !loop.length) return { name: null, isSubstitute: false };
  const diff = dayDiff(dateStr);
  if (diff < 0) return { name: null, isSubstitute: false };

  const baseIdx = diff % loop.length;
  for (let i = 0; i < loop.length; i++) {
    const name = loop[(baseIdx + i) % loop.length].main;
    if (!isOnLeave(name, dateStr)) {
      return { name: name || null, isSubstitute: i > 0 };
    }
  }
  return { name: null, isSubstitute: false };
}

// 크첵 계산 — needCheck 위치는 루프 순서 그대로 유지, 담당자만 연차 건너뜀
function getCheck(dateStr) {
  if (`${dateStr}:check` in overrides) {
    return { name: overrides[`${dateStr}:check`] || null, isSubstitute: false };
  }
  const { loop, checkLoop, startDate } = sheetCache;
  if (!startDate || !loop.length || !checkLoop.length) return { name: null, isSubstitute: false };
  const diff = dayDiff(dateStr);
  if (diff < 0) return { name: null, isSubstitute: false };

  const idx = diff % loop.length;
  if (!loop[idx].needCheck) return { name: null, isSubstitute: false };

  const numCheckPerCycle = loop.filter(r => r.needCheck).length;
  const fullCycles = Math.floor(diff / loop.length);
  const checksUpToIdx = loop.slice(0, idx + 1).filter(r => r.needCheck).length;
  const totalCheckCount = fullCycles * numCheckPerCycle + checksUpToIdx;
  const baseCheckIdx = (totalCheckCount - 1) % checkLoop.length;

  for (let i = 0; i < checkLoop.length; i++) {
    const name = checkLoop[(baseCheckIdx + i) % checkLoop.length].check;
    if (!isOnLeave(name, dateStr)) {
      return { name: name || null, isSubstitute: i > 0 };
    }
  }
  return { name: null, isSubstitute: false };
}

function mentionTag(name) {
  const id = sheetCache.members[name];
  return id ? `<@${id}>` : `*${name}*`;
}

// 슬랙 유저 ID → 멤버 시트 이름 (없으면 null)
function memberNameById(userId) {
  for (const [name, id] of Object.entries(sheetCache.members)) {
    if (id && id === userId) return name;
  }
  return null;
}

// 해당 날짜에 name의 역할 판별: 'main' | 'check' | null (메인 우선)
function requesterRole(dateStr, name) {
  if (!name) return null;
  if (name === getMain(dateStr).name) return 'main';
  if (name === getCheck(dateStr).name) return 'check';
  return null;
}

// ─── 메시지 포맷 ──────────────────────────────────────
function formatDutyLine(mainName, checkName, withTag) {
  const mainText = withTag ? mentionTag(mainName) : `*${mainName}*`;
  if (checkName && checkName !== 'NONE') {
    const checkText = withTag ? mentionTag(checkName) : `*${checkName}*`;
    return `${mainText} (${checkText})`;
  }
  return mainText;
}

function dutyMessage(dateStr, withTag = false) {
  const label = dateLabel(dateStr);
  const { name: main } = getMain(dateStr);
  const { name: check } = getCheck(dateStr);
  const line = main ? formatDutyLine(main, check, withTag) : '—';
  return `🔔 *[당번 알림]* ${label}\n\n오늘 당번은 ${line} 님입니다! 수고해주세요 💪`;
}

function eveningMessage(tomorrowStr, withTag = false) {
  const label = dateLabel(tomorrowStr);
  const { name: main } = getMain(tomorrowStr);
  const { name: check } = getCheck(tomorrowStr);
  const line = main ? formatDutyLine(main, check, withTag) : '—';
  return `🌙 *[내일 당번 예고]* ${label}\n\n내일 당번은 ${line} 님입니다!`;
}

function weeklyMessage(fromDateStr) {
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const lines = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(fromDateStr);
    d.setDate(d.getDate() + i);
    const ds = d.toLocaleDateString('sv-SE');
    const [, mm, dd] = ds.split('-');
    const day = dayNames[d.getDay()];
    const { name: main } = getMain(ds);
    const { name: check } = getCheck(ds);
    const mainStr = main || '—';
    const dutyLine = (check && check !== 'NONE') ? `${mainStr} (${check})` : mainStr;
    lines.push(`• ${mm}.${dd} (${day})  ${dutyLine}`);
  }
  return lines.join('\n');
}

// ─── 이번달 주차별 일정 ───────────────────────────────
// 해당 월에 속한 날짜를 주차별로 그룹핑
function getMonthWeeks(dateStr) {
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = d.getMonth(); // 0-based
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeksMap = {};
  for (let day = 1; day <= daysInMonth; day++) {
    const cur = new Date(year, month, day);
    const week = Math.ceil((day + firstDay.getDay()) / 7);
    const ds = cur.toLocaleDateString('sv-SE');
    (weeksMap[week] = weeksMap[week] || []).push(ds);
  }
  return Object.keys(weeksMap).map(w => ({
    week: Number(w),
    label: `${month + 1}월 ${w}주차`,
    dates: weeksMap[w],
  }));
}

function formatWeekDates(dates) {
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  return dates.map(ds => {
    const [, mm, dd] = ds.split('-');
    const day = dayNames[new Date(ds).getDay()];
    const { name: main } = getMain(ds);
    const { name: check } = getCheck(ds);
    const mainStr = main || '—';
    const dutyLine = (check && check !== 'NONE') ? `${mainStr} (${check})` : mainStr;
    return `• ${mm}.${dd} (${day})  ${dutyLine}`;
  }).join('\n');
}

// ─── 주간 스레드 ──────────────────────────────────────
async function updateWeeklyThread() {
  try {
    const ts = await getThreadTs();
    if (!ts) return;
    const threadDate = new Date(parseFloat(ts) * 1000);
    const threadDateStr = threadDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const d = new Date(threadDateStr);
    const dow = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    const mondayStr = monday.toLocaleDateString('sv-SE');
    const weekLabel = getWeekLabel(mondayStr);
    await app.client.chat.update({
      channel: CONFIG.notifyChannel,
      ts,
      text: `📅 *${weekLabel} 당번 일정*\n\n${weeklyMessage(mondayStr)}`,
    });
  } catch (e) {
    console.error('주간 스레드 업데이트 실패:', e.message);
  }
}

async function ensureWeeklyThread() {
  const ts = await getThreadTs();
  if (ts) return ts;
  const today = todayStr();
  const weekLabel = getWeekLabel(today);
  const res = await app.client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    text: `📅 *${weekLabel} 당번 일정*\n\n${weeklyMessage(today)}`,
  });
  await setThreadTs(res.ts);
  return res.ts;
}

// ─── 매뉴얼 ───────────────────────────────────────────
const MANUAL_TEXT = `📖 *당번봇 매뉴얼*

🤖 *이 봇은 무엇인가요?*
매일 아침 당번을 자동으로 알려주는 봇이에요.
당번 순서는 구글 시트에서 관리하고, 봇은 시트를 읽어서 알림을 보내요.
순서 변경이나 팀원 추가는 시트에서 직접 수정하면 돼요.

📅 *자동 알림*
• 매주 월요일 07:00 — 이번 주 당번 스레드 생성
• 매일 07:30 — 오늘 당번 알림 + 당번자 태그
• 매일 18:00 — 내일 당번 예고 + 당번자 태그

🔍 *당번 확인*
\`@당번봇 이번주\` — 이번 주 일정
\`@당번봇 다음주\` — 다음 주 일정
\`@당번봇 이번달\` — 이번 달 주차별 일정 선택
\`@당번봇 MM.DD\` — 특정 날짜 당번 조회

✏️ *당번 변경*
\`@당번봇 변경 MM.DD 홍길동\` — 해당 날짜 당번 직접 변경
\`@당번봇 취소 MM.DD\` — 변경 취소, 원래 순서로 복구

🙏 *교체 요청*
\`@당번봇 요청 MM.DD\` — 대리 또는 날짜 교체 요청
→ *대리 요청*: 그날 당번을 대신해줄 사람 구하기 (수락 시 자동 변경)
→ *날짜 교체*: 다른 날짜 당번과 서로 바꾸기 (수락 시 자동 교체)

🏖️ *연차*
\`@당번봇 연차 홍길동 MM.DD~MM.DD\` — 연차 등록
\`@당번봇 연차취소 홍길동 MM.DD~MM.DD\` — 연차 취소
\`@당번봇 연차확인\` — 등록된 연차 목록

⚙️ *관리자*
\`@당번봇 캐시갱신\` — 구글 시트 변경사항 즉시 반영`;

// ─── 연차 슬래시 커맨드 공통 파서 ────────────────────
function parseLeaveArgs(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [name, rangeStr] = parts;
  const dates = parseDateRange(rangeStr);
  if (!dates) return null;
  return { name, dates, rangeStr };
}

// ─── 거절 랜덤 멘트 ───────────────────────────────────
const DECLINE_LINES = [
  (n) => `${n} 님이 이번엔 어렵대요 🥲`,
  (n) => `${n} 님은 이번엔 패스! 다른 분은요? 🙏`,
  (n) => `${n} 님이 손을 저었어요 🥲 다음 분!`,
  (n) => `${n} 님은 오늘 일정이 있대요 😢 다른 분 없을까요?`,
  (n) => `${n} 님이 고개를 젓네요 🥲`,
];
function randomDecline(name) {
  return DECLINE_LINES[Math.floor(Math.random() * DECLINE_LINES.length)](name);
}

// ─── 요청 방식: 대리 요청 (채널 공지) ────────────────
app.action('req_delegate', async ({ body, ack, client, respond }) => {
  await ack();
  const { date, role } = JSON.parse(body.actions[0].value);
  const requesterName = memberNameById(body.user.id) || await getRealName(app.client, body.user.id);
  const roleLabel = role === 'check' ? '크첵' : '메인';

  // 태그 대상: 메인 → 멤버 전체, 크첵 → 크첵루프 인원 (본인 제외)
  const pool = role === 'check'
    ? sheetCache.checkLoop.map(r => r.check)
    : Object.keys(sheetCache.members);
  const tagNames = [...new Set(pool)].filter(n => n && n !== 'NONE' && n !== requesterName);
  const tagText = tagNames.map(n => mentionTag(n)).join(' ');

  const actionValue = JSON.stringify({ date, requester: requesterName, role });
  await client.chat.postMessage({
    channel: body.channel.id,
    text: `🙏 ${dateLabel(date)} ${roleLabel} 당번 교체 요청`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${tagText}\n${requesterName} 님이 ${dateLabel(date)} ${roleLabel} 당번을 대신 해주실 분을 찾고 있어요. 😢🙏` } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '✅ 수락' }, style: 'primary', action_id: 'delegate_accept', value: actionValue },
        { type: 'button', text: { type: 'plain_text', text: '❌ 거절' }, style: 'danger', action_id: 'delegate_decline', value: actionValue },
      ]},
    ],
  });
  await respond({ replace_original: true, text: `✅ 채널에 *${dateLabel(date)}* ${roleLabel} 대리 요청을 올렸어요.` });
});

// ─── 요청 방식: 날짜 교체 (모달로 날짜 입력) ──────────
app.action('req_swap', async ({ body, ack, client, respond }) => {
  await ack();
  const { date, role } = JSON.parse(body.actions[0].value);
  const roleLabel = role === 'check' ? '크첵' : '메인';
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal', callback_id: 'swap_modal',
      private_metadata: JSON.stringify({ date, role, channel: body.channel.id }),
      title: { type: 'plain_text', text: '날짜 교체 요청' },
      submit: { type: 'plain_text', text: '요청' },
      close: { type: 'plain_text', text: '취소' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${dateLabel(date)}* ${roleLabel} 당번을 바꿀 날짜를 입력해줘요.` } },
        { type: 'input', block_id: 'swap_date',
          label: { type: 'plain_text', text: '교체하고 싶은 다른 날짜를 입력해줘요 (예: 07.21)' },
          element: { type: 'plain_text_input', action_id: 'picked', placeholder: { type: 'plain_text', text: '07.21' } } },
      ],
    },
  });
  await respond({ replace_original: true, text: '🔄 날짜 교체 요청 창을 열었어요. (창에서 날짜를 입력하세요)' });
});

// 날짜 교체 모달 제출 → 상대 당번에게 태그해 채널 공지
app.view('swap_modal', async ({ body, ack, view, client }) => {
  const { date, role, channel } = JSON.parse(view.private_metadata);
  const raw = (view.state.values['swap_date']?.['picked']?.value || '').trim();
  const date2 = parseDate(raw);
  if (!date2) { await ack({ response_action: 'errors', errors: { swap_date: '날짜 형식은 MM.DD 예요 (예: 07.21)' } }); return; }
  if (date2 === date) { await ack({ response_action: 'errors', errors: { swap_date: '같은 날짜로는 교체할 수 없어요.' } }); return; }

  const roleLabel = role === 'check' ? '크첵' : '메인';
  const counterpart = role === 'check' ? getCheck(date2).name : getMain(date2).name;
  if (!counterpart || counterpart === 'NONE') {
    await ack({ response_action: 'errors', errors: { swap_date: `그 날짜에 ${roleLabel} 당번이 없어요.` } });
    return;
  }
  await ack();

  const requesterName = memberNameById(body.user.id) || await getRealName(app.client, body.user.id);
  const actionValue = JSON.stringify({ date, date2, role, requester: requesterName, counterpart });
  await client.chat.postMessage({
    channel,
    text: `🔄 ${dateLabel(date)} ↔ ${dateLabel(date2)} 날짜 교체 요청`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${mentionTag(counterpart)}\n${requesterName} 님이 날짜 교체를 요청해요. 😢🙏\n${dateLabel(date)} ${requesterName} ↔ ${dateLabel(date2)} ${counterpart}` } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '✅ 수락' }, style: 'primary', action_id: 'swap_accept', value: actionValue },
        { type: 'button', text: { type: 'plain_text', text: '❌ 거절' }, style: 'danger', action_id: 'swap_decline', value: actionValue },
      ]},
    ],
  });
});

// ─── 대리 요청 수락/거절 ──────────────────────────────
app.action('delegate_accept', async ({ body, ack, client }) => {
  await ack();
  const { date, requester, role } = JSON.parse(body.actions[0].value);
  const acceptor = memberNameById(body.user.id) || await getRealName(app.client, body.user.id);
  const roleLabel = role === 'check' ? '크첵' : '메인';
  overrides[`${date}:${role === 'check' ? 'check' : 'main'}`] = acceptor;
  await syncOverrideRow(date);
  await client.chat.update({
    channel: body.channel.id, ts: body.message.ts, text: `✅ 당번 교체 완료`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ *${dateLabel(date)}* ${roleLabel} 당번이 ${acceptor} 님으로 변경됐어요. ${requester} → ${acceptor}` } }],
  });
  await updateWeeklyThread();
});

app.action('delegate_decline', async ({ body, ack, client }) => {
  await ack();
  const decliner = memberNameById(body.user.id) || await getRealName(app.client, body.user.id);
  await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message.ts, text: randomDecline(decliner) });
});

// ─── 날짜 교체 수락/거절 ──────────────────────────────
app.action('swap_accept', async ({ body, ack, client }) => {
  await ack();
  const { date, date2, role, requester, counterpart } = JSON.parse(body.actions[0].value);
  const roleKey = role === 'check' ? 'check' : 'main';
  overrides[`${date}:${roleKey}`] = counterpart;
  overrides[`${date2}:${roleKey}`] = requester;
  await syncOverrideRow(date);
  await syncOverrideRow(date2);
  await client.chat.update({
    channel: body.channel.id, ts: body.message.ts, text: `✅ 날짜 교체 완료`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ *${dateLabel(date)}* ↔ *${dateLabel(date2)}* 교체 완료! ${requester} ↔ ${counterpart}` } }],
  });
  await updateWeeklyThread();
});

app.action('swap_decline', async ({ body, ack, client }) => {
  await ack();
  const decliner = memberNameById(body.user.id) || await getRealName(app.client, body.user.id);
  await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message.ts, text: randomDecline(decliner) });
});

// ─── 이번달 주차 선택 버튼 ────────────────────────────
function monthSelectBlocks(anchor) {
  const weeks = getMonthWeeks(anchor);
  const monthNum = new Date(anchor).getMonth() + 1;
  const options = weeks.map(w => ({
    text: { type: 'plain_text', text: w.label },
    value: String(w.week),
  }));
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `📅 *${monthNum}월 당번 일정*\n\n조회할 주차를 선택하세요. (복수 선택 가능)` } },
    { type: 'actions', block_id: 'month_weeks', elements: [
      { type: 'checkboxes', action_id: 'month_week_select', options },
    ]},
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: '✅ 확인' }, style: 'primary', action_id: 'month_confirm', value: anchor },
      { type: 'button', text: { type: 'plain_text', text: '📋 전체보기' }, action_id: 'month_all', value: anchor },
    ]},
  ];
}

// 체크박스 선택 자체는 ack만
app.action('month_week_select', async ({ ack }) => { await ack(); });

// 버튼 메시지에서 버튼 제거 + "선택 완료" 텍스트로 교체
async function markMonthSelectDone(client, body, monthNum) {
  await client.chat.update({
    channel: body.channel.id, ts: body.message.ts,
    text: `📅 ${monthNum}월 주차 선택 완료`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `📅 *${monthNum}월 주차 선택 완료*` } }],
  });
}

app.action('month_confirm', async ({ body, ack, client }) => {
  await ack();
  const anchor = body.actions[0].value;
  const threadTs = body.message.thread_ts || body.message.ts;
  const monthNum = new Date(anchor).getMonth() + 1;
  const selected = body.state?.values?.['month_weeks']?.['month_week_select']?.selected_options || [];
  if (!selected.length) {
    await client.chat.postMessage({ channel: body.channel.id, thread_ts: threadTs, text: '❌ 주차를 하나 이상 선택해주세요.' });
    return;
  }
  await markMonthSelectDone(client, body, monthNum);
  const selectedNums = selected.map(o => Number(o.value));
  const chosen = getMonthWeeks(anchor).filter(w => selectedNums.includes(w.week));
  const sections = chosen.map(w => `📅 *${w.label}*\n${formatWeekDates(w.dates)}`).join('\n\n');
  await client.chat.postMessage({ channel: body.channel.id, thread_ts: threadTs, text: sections });
});

app.action('month_all', async ({ body, ack, client }) => {
  await ack();
  const anchor = body.actions[0].value;
  const threadTs = body.message.thread_ts || body.message.ts;
  const monthNum = new Date(anchor).getMonth() + 1;
  await markMonthSelectDone(client, body, monthNum);
  const sections = getMonthWeeks(anchor).map(w => `📅 *${w.label}*\n${formatWeekDates(w.dates)}`).join('\n\n');
  await client.chat.postMessage({ channel: body.channel.id, thread_ts: threadTs, text: `📅 *${monthNum}월 전체 당번 일정*\n\n${sections}` });
});

// ─── 매주 월요일 07:00 — 새 주간 스레드 생성 ──────────
cron.schedule(CONFIG.weeklyTime, async () => {
  const today = todayStr();
  const weekLabel = getWeekLabel(today);
  const res = await app.client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    text: `📅 *${weekLabel} 당번 일정*\n\n${weeklyMessage(today)}`,
  });
  try {
    await setThreadTs(res.ts);
  } catch (e) {
    console.error('Railway 환경변수 업데이트 실패:', e.message);
  }
}, { timezone: 'Asia/Seoul' });

// ─── 매일 07:30 — 오늘 당번 알림 + 태그 ──────────────
cron.schedule(CONFIG.notifyTime, async () => {
  const today = todayStr();
  const ts = await ensureWeeklyThread();
  await app.client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    thread_ts: ts,
    text: dutyMessage(today, true),
  });
}, { timezone: 'Asia/Seoul' });

// ─── 매일 18:00 — 내일 당번 예고 + 태그 ──────────────
cron.schedule(CONFIG.eveningNotifyTime, async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const ts = await ensureWeeklyThread();
  await app.client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    thread_ts: ts,
    text: eveningMessage(tomorrowStr, true),
  });
}, { timezone: 'Asia/Seoul' });

// ─── @당번봇 멘션 처리 ────────────────────────────────
app.event('app_mention', async ({ event, client, say }) => {
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const cmd = parts[0];
  const threadTs = event.thread_ts || event.ts;

  const reply = async (msg) => { await say({ text: msg, thread_ts: threadTs }); };

  // 매뉴얼 (빈 멘션 포함)
  if (!cmd || cmd === '매뉴얼') {
    await reply(MANUAL_TEXT); return;
  }

  // 캐시갱신
  if (cmd === '캐시갱신') {
    await reply('🔄 시트 캐시 갱신 중...');
    await loadSheets();
    await loadPersisted();
    await reply(`✅ 캐시 갱신 완료! 멤버 ${Object.keys(sheetCache.members).length}명 / 루프 ${sheetCache.loop.length}칸 / 크첵루프 ${sheetCache.checkLoop.length}칸 / 변경 ${Object.keys(overrides).length ? Object.keys(overrides).filter(k => k.endsWith(':main')).length : 0}건 / 연차 ${Object.keys(leaves).length}명`);
    return;
  }

  // 이번주
  if (cmd === '이번주') {
    const today = todayStr();
    await reply(`📅 *${getWeekLabel(today)} 당번 일정*\n${weeklyMessage(today)}`); return;
  }

  // 다음주
  if (cmd === '다음주') {
    const d = new Date(todayStr());
    d.setDate(d.getDate() + 7);
    const nextWeek = d.toLocaleDateString('sv-SE');
    await reply(`📅 *${getWeekLabel(nextWeek)} 당번 일정*\n${weeklyMessage(nextWeek)}`); return;
  }

  // 이번달 — 주차 선택 버튼
  if (cmd === '이번달') {
    await say({ text: '📅 이번 달 당번 일정 — 주차를 선택하세요.', thread_ts: threadTs, blocks: monthSelectBlocks(todayStr()) });
    return;
  }

  // 변경 MM.DD 홍길동  (홍길동(이석영) 형태로 크첵 동시 변경 가능)
  if (cmd === '변경') {
    if (parts.length !== 3) { await reply('❌ 사용법: `@당번봇 변경 MM.DD 홍길동`'); return; }
    const date = parseDate(parts[1]);
    if (!date) { await reply('❌ 날짜 형식: `MM.DD` (예: 06.04)'); return; }
    const nameInput = parts[2];
    const combinedMatch = nameInput.match(/^(.+?)\((.+?)\)$/);

    // 변경 전 담당자 (override 반영 전에 계산)
    const prevMain = getMain(date).name || '—';
    const prevCheck = getCheck(date).name;

    if (combinedMatch) {
      const [, mainName, checkName] = combinedMatch;
      overrides[`${date}:main`] = mainName;
      overrides[`${date}:check`] = checkName;
      await syncOverrideRow(date);
      await updateWeeklyThread();
      const beforeStr = (prevCheck && prevCheck !== 'NONE') ? `${prevMain}(${prevCheck})` : prevMain;
      await reply(`✅ *${dateLabel(date)}* ${beforeStr} → ${mainName}(${checkName}) 으로 변경했어요.`);
      return;
    }
    overrides[`${date}:main`] = nameInput;
    delete overrides[`${date}:check`];
    await syncOverrideRow(date);
    await updateWeeklyThread();
    await reply(`✅ *${dateLabel(date)}* ${prevMain} → ${nameInput} 으로 변경했어요.`);
    return;
  }

  // 취소 MM.DD
  if (cmd === '취소') {
    const date = parseDate(parts[1] || '');
    if (!date) { await reply('❌ 사용법: `@당번봇 취소 MM.DD`'); return; }
    const keys = [`${date}:main`, `${date}:check`];
    const removed = keys.filter(k => k in overrides);
    removed.forEach(k => delete overrides[k]);
    if (removed.length > 0) {
      await syncOverrideRow(date);
      await updateWeeklyThread();
      await reply(`↩️ *${dateLabel(date)}* 변경을 취소했어요.`);
    } else {
      await reply(`ℹ️ 변경된 내용이 없어요.`);
    }
    return;
  }

  // 요청 MM.DD — 본인 역할(메인/크첵) 자동 구분 후 요청 방식 선택 (나에게만 표시)
  if (cmd === '요청') {
    const date = parseDate(parts[1] || '');
    if (!date) { await reply('❌ 사용법: `@당번봇 요청 MM.DD`'); return; }

    const requesterName = memberNameById(event.user);
    const role = requesterRole(date, requesterName);
    if (!role) {
      await client.chat.postEphemeral({
        channel: event.channel, user: event.user,
        text: `❌ ${dateLabel(date)} 당번자가 아니에요. 본인 당번날만 요청할 수 있어요.`,
      });
      return;
    }

    const roleLabel = role === 'main' ? '메인' : '크첵';
    const val = JSON.stringify({ date, role });
    await client.chat.postEphemeral({
      channel: event.channel, user: event.user,
      text: `${dateLabel(date)} ${roleLabel} 당번 요청`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `🙏 *${dateLabel(date)}* ${roleLabel} 당번 요청\n어떤 방식으로 요청할까요?` } },
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: '🙋 대리 요청' }, style: 'primary', action_id: 'req_delegate', value: val },
          { type: 'button', text: { type: 'plain_text', text: '🔄 날짜 교체' }, action_id: 'req_swap', value: val },
        ]},
      ],
    });
    return;
  }

  // 연차 홍길동 MM.DD~MM.DD
  if (cmd === '연차') {
    const parsed = parts.length === 3 ? parseLeaveArgs(`${parts[1]} ${parts[2]}`) : null;
    if (!parsed) { await reply('❌ 사용법: `@당번봇 연차 홍길동 MM.DD~MM.DD`'); return; }
    const { name, dates, rangeStr } = parsed;
    addLeave(name, dates);
    await persistLeaveAdd(name, dates[0], dates[dates.length - 1]);
    await reply(`🏖️ *${name}* 님 연차 등록 완료 (${rangeStr}, ${dates.length}일)`);
    return;
  }

  // 연차취소 홍길동 MM.DD~MM.DD
  if (cmd === '연차취소') {
    const parsed = parts.length === 3 ? parseLeaveArgs(`${parts[1]} ${parts[2]}`) : null;
    if (!parsed) { await reply('❌ 사용법: `@당번봇 연차취소 홍길동 MM.DD~MM.DD`'); return; }
    const { name, dates, rangeStr } = parsed;
    const removed = removeLeave(name, dates);
    if (removed > 0) {
      await persistLeaveRemove(name, dates[0], dates[dates.length - 1]);
      await reply(`↩️ *${name}* 님 연차 취소 완료 (${rangeStr}, ${removed}일)`);
    } else {
      await reply(`ℹ️ *${name}* 님의 해당 날짜 연차가 없어요.`);
    }
    return;
  }

  // 연차확인
  if (cmd === '연차확인') {
    await reply(leaveListText()); return;
  }

  // MM.DD — 특정 날짜 당번 조회
  const dateQuery = parseDate(cmd);
  if (dateQuery) {
    const { name: main } = getMain(dateQuery);
    const { name: check } = getCheck(dateQuery);
    const line = main ? formatDutyLine(main, check, false) : '—';
    await reply(`📅 *${dateLabel(dateQuery)}* 당번: ${line} 님`); return;
  }

  await reply(`❓ 모르는 명령어예요. \`@당번봇 매뉴얼\` 로 사용법을 확인해주세요!`);
});

// ─── 서버 시작 ────────────────────────────────────────
(async () => {
  await loadSheets();
  await loadPersisted();
  await app.start(process.env.PORT || 3000);
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id;
  console.log('⚡ 당번 봇이 실행 중입니다! Bot ID:', botUserId);
})();
