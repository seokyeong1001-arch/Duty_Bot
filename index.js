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

// 팀별 주간 스레드 ts 는 Railway 변수 team.threadVar 에 둔다.
// 아직 팀별 변수가 없으면 legacyThreadVar(구 WEEKLY_THREAD_TS)로 폴백한다 — 파인트팀만 해당.
async function getThreadTs(team) {
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
  const vars = json.data.variables || {};
  return vars[team.threadVar] || (team.legacyThreadVar && vars[team.legacyThreadVar]) || null;
}

async function setThreadTs(team, ts) {
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
        input: { projectId, environmentId, serviceId, name: team.threadVar, value: ts },
      },
    }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
}

// ─── Google Sheets CSV ────────────────────────────────
const SHEET_ID = '1AJ297G3fIa_P4qcF1vrC3aTsJNjC6baKvsmSrD1Wh_4';
// gviz CSV 응답에는 CDN 캐시가 붙어 방금 고친 시트가 옛 값으로 돌아올 수 있다.
// 요청마다 캐시 버스터를 붙이고 fetch도 no-store로 보낸다.
const sheetUrl = (tab) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}&_cb=${Date.now()}`;

// ─── 팀 ───────────────────────────────────────────────
// 팀은 채널로 구분한다. 시트 탭·스레드 ts·캐시·변경·연차가 전부 팀 단위로 독립이다.
//   탭: <접두어>_루프 / _크첵루프 / _멤버 / _변경(날짜|메인|크첵) / _연차(이름|시작일|종료일)
function createTeam({ key, label, prefix, channel, threadVar, legacyThreadVar = null, seedOverrides = [] }) {
  return {
    key, label, channel, threadVar, legacyThreadVar,
    tabs: {
      member: `${prefix}_멤버`,
      loop: `${prefix}_루프`,
      checkLoop: `${prefix}_크첵루프`,
      override: `${prefix}_변경`,
      leave: `${prefix}_연차`,
    },
    // 변경 탭을 새로 만들 때만 넣는 1회성 시드 (메모리 → 시트 이관용)
    seedOverrides,
    sheetCache: { members: {}, loop: [], checkLoop: [], startDate: '' },
    overrides: {},
    leaves: {}, // { '이름': Set<'YYYY-MM-DD'> }
    rotationVersion: 0,
    rotationCache: null,
  };
}

const TEAMS = [
  createTeam({
    key: 'pint', label: '파인트팀', prefix: '파인트',
    channel: process.env.SLACK_CHANNEL_PINT || process.env.SLACK_CHANNEL,
    threadVar: 'WEEKLY_THREAD_TS_PINT', legacyThreadVar: 'WEEKLY_THREAD_TS',
    seedOverrides: [{ date: '2026-07-14', main: '손유곤', check: '문선정' }],
  }),
  createTeam({
    key: 'stick', label: '스틱바팀', prefix: '스틱바',
    channel: process.env.SLACK_CHANNEL_STICK || 'C0B659HEYDV',
    threadVar: 'WEEKLY_THREAD_TS_STICK',
  }),
];

function teamByChannel(channelId) {
  if (!channelId) return null;
  return TEAMS.find(t => t.channel && t.channel === channelId) || null;
}

const UNREGISTERED_CHANNEL_TEXT =
  '이 채널은 당번봇에 등록되어 있지 않아요. 파인트팀 또는 스틱바팀 채널에서 사용해주세요.';

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
// gviz 는 없는 탭 이름을 받으면 에러 대신 "첫 번째 탭"을 돌려준다.
// 탭 이름이 틀리면 다른 팀 루프를 읽게 되므로, 자격증명이 있으면 탭 존재를 먼저 확인한다.
async function existingTabTitles() {
  if (!hasSheetsCreds()) return null;
  try {
    const meta = await getSheetsClient().spreadsheets.get({ spreadsheetId: SHEET_ID });
    return new Set(meta.data.sheets.map(s => s.properties.title));
  } catch (e) {
    console.error('[시트 캐시] 탭 목록 조회 실패:', e.message);
    return null;
  }
}

async function fetchTabRows(tab, titles) {
  if (titles && !titles.has(tab)) {
    console.warn(`[시트 캐시] 탭 없음 — '${tab}' 를 빈 탭으로 취급`);
    return [];
  }
  const res = await fetch(sheetUrl(tab), { cache: 'no-store' });
  return parseCSV(await res.text());
}

async function loadSheets(team) {
  try {
    const titles = await existingTabTitles();
    const [memberRows, loopRows, checkRows] = await Promise.all([
      fetchTabRows(team.tabs.member, titles),
      fetchTabRows(team.tabs.loop, titles),
      fetchTabRows(team.tabs.checkLoop, titles),
    ]);

    const members = {};
    for (const row of memberRows) {
      if (row['이름']) members[row['이름']] = row['슬랙ID'] || '';
    }

    team.sheetCache = {
      members,
      startDate: loopRows[0]?.['시작일'] || '',
      // 메인이 비어 있는 행은 아직 채우지 않은 칸이라 루프에서 뺀다
      loop: loopRows
        .filter(r => r['메인'])
        .map(r => ({ main: r['메인'], needCheck: r['크첵필요'] === 'O' })),
      checkLoop: checkRows.filter(r => r['크첵']).map(r => ({ check: r['크첵'] })),
    };

    console.log(
      `[시트 캐시][${team.label}] 갱신 완료 — 멤버 ${Object.keys(members).length}명 / ` +
      `루프 ${team.sheetCache.loop.length}칸 / 크첵루프 ${team.sheetCache.checkLoop.length}칸 / ` +
      `시작일 ${team.sheetCache.startDate}`
    );
  } catch (e) {
    console.error(`[시트 캐시][${team.label}] 로드 실패:`, e.message);
  } finally {
    // 성공이든 실패든 파생 캐시는 버린다 — 다음 계산이 항상 현재 sheetCache로 재구성되도록
    invalidateRotation(team);
  }
}

// 운영 중인지: 루프에 사람이 있고 시작일이 오늘(또는 지정일) 이전이어야 한다.
// 운영 전 팀은 자동 알림·주간 스레드 생성·조회를 하지 않는다.
function isOperating(team, dateStr = todayStr()) {
  const { loop, startDate } = team.sheetCache;
  const start = normalizeDate(startDate);
  return !!(loop.length && start && start <= dateStr);
}

function notOperatingText(team) {
  const start = normalizeDate(team.sheetCache.startDate);
  const when = (start && team.sheetCache.loop.length && start > todayStr())
    ? ` (${dateLabel(start)} 시작 예정)` : '';
  return `🕐 ${team.label}은 아직 당번 운영 전이에요${when}.\n시트를 채운 뒤 \`@당번봇 캐시갱신\` 하면 바로 시작돼요.`;
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

// 팀의 변경/연차 탭이 없으면 생성하고 헤더/시드 보장, sheetId 매핑 저장
async function ensureTabs(team) {
  const OVERRIDE_TAB = team.tabs.override;
  const LEAVE_TAB = team.tabs.leave;
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
  if (created.includes(OVERRIDE_TAB) && team.seedOverrides.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${OVERRIDE_TAB}!A1`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: team.seedOverrides.map(o => [o.date, o.main, o.check || '']) },
    });
    console.log(`[영구저장][${team.label}] 변경 탭 생성 + 시드 ${team.seedOverrides.length}건 입력`);
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

// 팀의 메모리 overrides 상태를 변경 탭 한 행에 반영 (없으면 삭제)
async function syncOverrideRow(team, date) {
  if (!hasSheetsCreds()) return;
  const { overrides } = team;
  const OVERRIDE_TAB = team.tabs.override;
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
    console.error(`[영구저장][${team.label}] 변경 반영 실패:`, e.message);
  }
}

// 팀 연차 탭에 [이름, 시작일, 종료일] 한 행 추가
async function persistLeaveAdd(team, name, startStr, endStr) {
  if (!hasSheetsCreds()) return;
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${team.tabs.leave}!A1`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[name, startStr, endStr]] },
    });
  } catch (e) {
    console.error(`[영구저장][${team.label}] 연차 등록 실패:`, e.message);
  }
}

// 팀 연차 탭에서 이름 일치 + 기간 겹치는 행 삭제
async function persistLeaveRemove(team, name, startStr, endStr) {
  if (!hasSheetsCreds()) return;
  const LEAVE_TAB = team.tabs.leave;
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
    console.error(`[영구저장][${team.label}] 연차 취소 실패:`, e.message);
  }
}

// 서버 시작/캐시갱신 시 팀의 변경/연차 탭을 읽어 메모리에 로드
async function loadPersisted(team) {
  if (!hasSheetsCreds()) {
    console.warn(`[영구저장][${team.label}] GOOGLE_SERVICE_ACCOUNT_JSON 미설정 — 메모리 전용 모드로 동작`);
    return;
  }
  const { overrides, leaves } = team;
  try {
    await ensureTabs(team);
    const sheets = getSheetsClient();

    // 변경
    for (const k of Object.keys(overrides)) delete overrides[k];
    const ov = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${team.tabs.override}!A2:C` });
    for (const row of (ov.data.values || [])) {
      const date = normalizeDate(row[0]);
      if (!date) continue;
      if (row[1]) overrides[`${date}:main`] = row[1];
      if (row[2]) overrides[`${date}:check`] = row[2];
    }

    // 연차
    for (const k of Object.keys(leaves)) delete leaves[k];
    invalidateRotation(team);
    const lv = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${team.tabs.leave}!A2:C` });
    for (const row of (lv.data.values || [])) {
      const name = (row[0] || '').trim();
      const start = normalizeDate(row[1]);
      if (!name || !start) continue;
      const end = normalizeDate(row[2]) || start;
      addLeave(team, name, expandRange(start, end));
    }

    console.log(
      `[영구저장][${team.label}] 로드 완료 — 변경 ${Object.keys(overrides).length}건(유효 ${upcomingOverrideCount(team)}건) / ` +
      `연차 ${Object.keys(leaves).length}명(유효 ${upcomingLeaveCount(team)}명)`
    );
  } catch (e) {
    console.error(`[영구저장][${team.label}] 로드 실패:`, e.message);
  } finally {
    // 중간에 실패해 부분 상태로 남았더라도 파생 캐시는 남기지 않는다
    invalidateRotation(team);
  }
}

// 팀 하나를 시트 → 메모리 → 파생 캐시 → 게시된 주간 스레드까지 한 번에 재구성한다.
// 파생 캐시(연차 커서 시뮬레이션)를 앞뒤로 두 번 버려서, 로드 도중 들어온 조회가
// 옛 커서를 되살려 캐시에 남기는 경우까지 막는다.
async function refreshAll(team, { updateThread = true } = {}) {
  invalidateRotation(team);
  await loadSheets(team);
  await loadPersisted(team);
  invalidateRotation(team);
  if (updateThread) await updateWeeklyThread(team);
}

// ─── 앱 ───────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// 리스너에서 처리 못 하고 올라온 에러는 여기서 반드시 로그로 남긴다
app.error(async (error) => {
  console.error('[Bolt] 처리되지 않은 에러:', error);
});

// 알림 채널은 팀마다 다르다 (TEAMS[].channel)
const CONFIG = {
  notifyTime: '30 7 * * *',
  weeklyTime: '0 7 * * 1',
  eveningNotifyTime: '0 18 * * *',
};

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
function isOnLeave(team, name, dateStr) {
  const { leaves } = team;
  return !!(name && leaves[name] && leaves[name].has(dateStr));
}

function addLeave(team, name, dates) {
  const { leaves } = team;
  if (!leaves[name]) leaves[name] = new Set();
  for (const d of dates) leaves[name].add(d);
  invalidateRotation(team);
}

function removeLeave(team, name, dates) {
  const { leaves } = team;
  if (!leaves[name]) return 0;
  let count = 0;
  for (const d of dates) { if (leaves[name].delete(d)) count++; }
  if (leaves[name].size === 0) delete leaves[name];
  if (count) invalidateRotation(team);
  return count;
}

function leaveListText(team) {
  const { leaves } = team;
  const names = Object.keys(leaves).filter(n => leaves[n].size > 0);
  if (!names.length) return 'ℹ️ 등록된 연차가 없어요.';
  const lines = names.map(name => {
    const sorted = [...leaves[name]].sort();
    const dates = sorted.map(dateLabel).join(', ');
    return `• *${name}*: ${dates}`;
  });
  return `📋 *등록된 연차 목록*\n\n${lines.join('\n')}`;
}

// ─── 유효(오늘 이후) 건수 집계 ─────────────────────────
// 변경/연차 데이터는 과거 조회용으로 전부 메모리에 들고 있지만,
// 캐시갱신 응답에는 아직 유효한 건수만 보여준다 (오늘 포함, Asia/Seoul 기준).

// 날짜가 오늘 이후인 변경 건수 — 같은 날의 메인/크첵은 1건으로 센다
function upcomingOverrideCount(team) {
  const { overrides } = team;
  const today = todayStr();
  const dates = new Set();
  for (const key of Object.keys(overrides)) {
    const date = key.slice(0, key.lastIndexOf(':'));
    if (date >= today) dates.add(date);
  }
  return dates.size;
}

// 종료일이 오늘 이후인 연차 인원 수 (연차는 날짜 Set이라 마지막 날짜가 종료일)
function upcomingLeaveCount(team) {
  const { leaves } = team;
  const today = todayStr();
  return Object.keys(leaves).filter(name => {
    for (const d of leaves[name]) { if (d >= today) return true; }
    return false;
  }).length;
}

// ─── 당번 계산 ────────────────────────────────────────
// 반환: { name: string|null, isSubstitute: boolean }
function dayDiff(team, dateStr) {
  const start = new Date(team.sheetCache.startDate);
  const target = new Date(dateStr);
  return Math.round((target - start) / (1000 * 60 * 60 * 24));
}

// 루프 시작일 기준 n일째 날짜 문자열 (dayDiff의 역함수)
function dateAtDiff(team, n) {
  const d = new Date(team.sheetCache.startDate);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── 연차 제외 로테이션 ───────────────────────────────
// 연차자는 차례를 "소비하지 않고" 건너뛴다. 건너뛴 칸만큼 커서가 함께 진행하므로
// 연차 기간에는 남은 인원만으로 순환한다.
//   예) 루프 [A,B,C,D,E]에서 C가 연차면 → A → B → D → E → A → B → D …
// 커서는 날짜순 누적 상태이므로 하루씩 시뮬레이션해서 팀별 캐시에 쌓는다.
// (연차가 등록되기 전 구간은 커서 = 달력 인덱스라서 시뮬레이션 없이 바로 계산)
function invalidateRotation(team) {
  team.rotationVersion++;
  team.rotationCache = null;
}

const EMPTY_ROTATION = { main: null, mainSub: false, check: null, checkSub: false };

// 등록된 연차 중 가장 이른 날의 diff (연차 없으면 null)
function earliestLeaveDiff(team) {
  const { leaves } = team;
  let min = null;
  for (const name of Object.keys(leaves)) {
    for (const d of leaves[name]) { if (min === null || d < min) min = d; }
  }
  if (min === null) return null;
  return Math.max(0, dayDiff(team, min));
}

// 연차 영향이 없는 구간의 커서 = 달력 인덱스
function baseCursors(team, diff) {
  const { loop, checkLoop } = team.sheetCache;
  const perCycle = loop.filter(r => r.needCheck).length;
  const cycles = Math.floor(diff / loop.length);
  const rest = loop.slice(0, diff % loop.length).filter(r => r.needCheck).length;
  return {
    main: diff % loop.length,
    check: checkLoop.length ? (cycles * perCycle + rest) % checkLoop.length : 0,
  };
}

function plainRotation(team, diff) {
  const { loop, checkLoop } = team.sheetCache;
  const idx = diff % loop.length;
  const check = (loop[idx].needCheck && checkLoop.length)
    ? (checkLoop[baseCursors(team, diff).check].check || null)
    : null;
  return { main: loop[idx].main || null, mainSub: false, check, checkSub: false };
}

// 커서를 하루 진행시키고 그날의 배정을 반환
function stepRotation(team, n) {
  const { loop, checkLoop } = team.sheetCache;
  const cache = team.rotationCache;
  const L = loop.length;
  const CL = checkLoop.length;
  const ds = dateAtDiff(team, n);

  // 메인 — 커서부터 연차가 아닌 첫 사람
  let idx = -1;
  let skip = 0;
  for (; skip < L; skip++) {
    const cand = loop[(cache.mainCursor + skip) % L].main;
    if (cand && !isOnLeave(team, cand, ds)) { idx = (cache.mainCursor + skip) % L; break; }
  }
  if (idx < 0) { // 전원 연차
    cache.mainCursor = (cache.mainCursor + 1) % L;
    return { ...EMPTY_ROTATION };
  }
  const main = loop[idx].main;
  cache.mainCursor = (idx + 1) % L; // 건너뛴 칸까지 함께 소비

  // 크첵 — 그날 메인의 '크첵필요' 여부로 판단, 크첵루프에서 연차자 건너뜀
  let check = null;
  let checkSub = false;
  if (loop[idx].needCheck && CL) {
    let cIdx = -1;
    let cSkip = 0;
    for (; cSkip < CL; cSkip++) {
      const cand = checkLoop[(cache.checkCursor + cSkip) % CL].check;
      if (cand && !isOnLeave(team, cand, ds)) { cIdx = (cache.checkCursor + cSkip) % CL; break; }
    }
    if (cIdx >= 0) {
      check = checkLoop[cIdx].check;
      checkSub = cSkip > 0;
      cache.checkCursor = (cIdx + 1) % CL; // 크첵 배정된 날만 진행
    }
  }
  return { main, mainSub: skip > 0, check, checkSub };
}

function simulatedRotation(team, targetDiff) {
  if (!team.rotationCache || team.rotationCache.version !== team.rotationVersion) {
    const anchor = earliestLeaveDiff(team) || 0;
    const base = baseCursors(team, anchor);
    team.rotationCache = {
      version: team.rotationVersion, next: anchor,
      mainCursor: base.main, checkCursor: base.check,
      map: new Map(),
    };
  }
  const cache = team.rotationCache;
  for (let n = cache.next; n <= targetDiff; n++) {
    cache.map.set(n, stepRotation(team, n));
    cache.next = n + 1;
  }
  return cache.map.get(targetDiff) || { ...EMPTY_ROTATION };
}

function rotationFor(team, dateStr) {
  const { loop, startDate } = team.sheetCache;
  if (!startDate || !loop.length) return EMPTY_ROTATION;
  const diff = dayDiff(team, dateStr);
  if (diff < 0) return EMPTY_ROTATION;

  const anchor = earliestLeaveDiff(team);
  // 연차가 없거나 첫 연차보다 이전 날짜면 달력 인덱스 그대로
  if (anchor === null || diff < anchor) return plainRotation(team, diff);
  return simulatedRotation(team, diff);
}

function getMain(team, dateStr) {
  const { overrides } = team;
  if (`${dateStr}:main` in overrides) {
    return { name: overrides[`${dateStr}:main`] || null, isSubstitute: false };
  }
  const r = rotationFor(team, dateStr);
  return { name: r.main, isSubstitute: r.mainSub };
}

function getCheck(team, dateStr) {
  const { overrides } = team;
  if (`${dateStr}:check` in overrides) {
    return { name: overrides[`${dateStr}:check`] || null, isSubstitute: false };
  }
  const r = rotationFor(team, dateStr);
  return { name: r.check, isSubstitute: r.checkSub };
}

function mentionTag(team, name) {
  const id = team.sheetCache.members[name];
  return id ? `<@${id}>` : `*${name}*`;
}

// 슬랙 유저 ID → 팀 멤버 시트 이름 (없으면 null)
function memberNameById(team, userId) {
  for (const [name, id] of Object.entries(team.sheetCache.members)) {
    if (id && id === userId) return name;
  }
  return null;
}

// 해당 날짜에 name의 역할 판별: 'main' | 'check' | null (메인 우선)
function requesterRole(team, dateStr, name) {
  if (!name) return null;
  if (name === getMain(team, dateStr).name) return 'main';
  if (name === getCheck(team, dateStr).name) return 'check';
  return null;
}

// ─── 메시지 포맷 ──────────────────────────────────────
function formatDutyLine(team, mainName, checkName, withTag) {
  const mainText = withTag ? mentionTag(team, mainName) : `*${mainName}*`;
  if (checkName && checkName !== 'NONE') {
    const checkText = withTag ? mentionTag(team, checkName) : `*${checkName}*`;
    return `${mainText} (${checkText})`;
  }
  return mainText;
}

function dutyMessage(team, dateStr, withTag = false) {
  const label = dateLabel(dateStr);
  const { name: main } = getMain(team, dateStr);
  const { name: check } = getCheck(team, dateStr);
  const line = main ? formatDutyLine(team, main, check, withTag) : '—';
  return `🔔 *[당번 알림]* ${label}\n\n오늘 당번은 ${line} 님입니다! 수고해주세요 💪`;
}

function eveningMessage(team, tomorrowStr, withTag = false) {
  const label = dateLabel(tomorrowStr);
  const { name: main } = getMain(team, tomorrowStr);
  const { name: check } = getCheck(team, tomorrowStr);
  const line = main ? formatDutyLine(team, main, check, withTag) : '—';
  return `🌙 *[내일 당번 예고]* ${label}\n\n내일 당번은 ${line} 님입니다!`;
}

function weeklyMessage(team, fromDateStr) {
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const lines = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(fromDateStr);
    d.setDate(d.getDate() + i);
    const ds = d.toLocaleDateString('sv-SE');
    const [, mm, dd] = ds.split('-');
    const day = dayNames[d.getDay()];
    const { name: main } = getMain(team, ds);
    const { name: check } = getCheck(team, ds);
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

function formatWeekDates(team, dates) {
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  return dates.map(ds => {
    const [, mm, dd] = ds.split('-');
    const day = dayNames[new Date(ds).getDay()];
    const { name: main } = getMain(team, ds);
    const { name: check } = getCheck(team, ds);
    const mainStr = main || '—';
    const dutyLine = (check && check !== 'NONE') ? `${mainStr} (${check})` : mainStr;
    return `• ${mm}.${dd} (${day})  ${dutyLine}`;
  }).join('\n');
}

// ─── 주간 스레드 ──────────────────────────────────────
async function updateWeeklyThread(team) {
  try {
    const ts = await getThreadTs(team);
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
      channel: team.channel,
      ts,
      text: `📅 *${weekLabel} 당번 일정*\n\n${weeklyMessage(team, mondayStr)}`,
    });
  } catch (e) {
    console.error(`[${team.label}] 주간 스레드 업데이트 실패:`, e.message);
  }
}

async function ensureWeeklyThread(team) {
  const ts = await getThreadTs(team);
  if (ts) return ts;
  // 운영 전 팀은 주간 스레드를 만들지 않는다 (빈 일정 스레드가 채널에 남지 않도록)
  if (!isOperating(team)) throw new Error(`${team.label} 운영 전이라 주간 스레드를 만들지 않아요.`);
  const today = todayStr();
  const weekLabel = getWeekLabel(today);
  const res = await app.client.chat.postMessage({
    channel: team.channel,
    text: `📅 *${weekLabel} 당번 일정*\n\n${weeklyMessage(team, today)}`,
  });
  await setThreadTs(team, res.ts);
  return res.ts;
}

// 팀 주간 스레드에 답글로 게시한다. 스레드가 없으면 ensureWeeklyThread() 로 먼저 확보.
async function postWeeklyReply(team, { text, blocks }) {
  const weeklyTs = await ensureWeeklyThread(team);
  const payload = { channel: team.channel, thread_ts: weeklyTs, text };
  if (blocks) payload.blocks = blocks;
  const res = await app.client.chat.postMessage(payload);
  console.log(`[주간스레드][${team.label}] 답글 게시 thread_ts=${weeklyTs} ts=${res.ts}`);
  return { weeklyTs, ts: res.ts };
}

// ─── 매뉴얼 ───────────────────────────────────────────
const MANUAL_TEXT = `📖 *당번봇 매뉴얼*

🤖 *이 봇은 무엇인가요?*
매일 아침 당번을 자동으로 알려주는 봇이에요.
당번 순서는 구글 시트에서 관리하고, 봇은 시트를 읽어서 알림을 보내요.
순서 변경이나 팀원 추가는 시트에서 직접 수정하면 돼요.
👥 팀(파인트팀/스틱바팀)은 명령어를 입력한 채널로 자동 구분돼요. 명령어는 똑같이 쓰면 돼요.

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

\`@당번봇 요청 MM.DD\` — 내가 못 하는 내 당번날을 입력해요
예) 10.27이 내 당번인데 못 할 때 → \`@당번봇 요청 10.27\`

입력하면 두 가지 중에 고를 수 있어요.

→ 대리 요청
그날을 대신해줄 사람을 팀에 물어봐요. 누군가 수락하면 그 사람으로 바뀌어요.

→ 날짜 교체
내 당번날과 다른 날을 맞바꿔요. 선택하면 바꾸고 싶은 날짜를 한 번 더 입력하고,
그날 당번자가 수락하면 서로 교체돼요.
예) 10.27 ↔ 10.30 교체

본인 당번날에만 쓸 수 있어요.

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

// 버튼이 달렸던 원본 메시지를 결과 텍스트로 교체한다.
// 방식 선택 메시지가 ephemeral 이 아닌 주간 스레드의 실제 메시지가 됐으므로
// respond(replace_original) 대신 chat.update 를 쓰고, 실패 시에만 respond 로 폴백한다.
async function replaceSourceMessage({ body, client, respond, text }) {
  try {
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts, text, blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
      ],
    });
    console.log(`[요청] 원본 메시지 교체 완료 ts=${body.message.ts}`);
  } catch (e) {
    console.error(`[요청] 원본 메시지 교체 실패 (${e.data?.error || e.message}) — respond 로 폴백`);
    await respond({ replace_original: true, text });
  }
}

// 버튼/모달이 눌린 채널로 팀을 찾는다. 등록되지 않은 채널이면 로그만 남기고 null.
function teamForAction(channelId, actionName) {
  const team = teamByChannel(channelId);
  if (!team) console.warn(`[${actionName}] 등록되지 않은 채널 ch=${channelId} — 무시`);
  return team;
}

// ─── 요청 방식: 대리 요청 (주간 스레드 공지) ──────────
app.action('req_delegate', async ({ body, ack, client, respond }) => {
  await ack();
  const team = teamForAction(body.channel?.id, 'req_delegate');
  if (!team) return;
  const { date, role } = JSON.parse(body.actions[0].value);
  const requesterName = memberNameById(team, body.user.id) || await getRealName(app.client, body.user.id);
  const roleLabel = role === 'check' ? '크첵' : '메인';

  // 태그 대상: 메인 → 팀 멤버 전체, 크첵 → 팀 크첵루프 인원 (본인 제외)
  const pool = role === 'check'
    ? team.sheetCache.checkLoop.map(r => r.check)
    : Object.keys(team.sheetCache.members);
  const tagNames = [...new Set(pool)].filter(n => n && n !== 'NONE' && n !== requesterName);
  const tagText = tagNames.map(n => mentionTag(team, n)).join(' ');

  const actionValue = JSON.stringify({ date, requester: requesterName, role });
  await postWeeklyReply(team, {
    text: `🙏 ${dateLabel(date)} ${roleLabel} 당번 교체 요청`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${tagText}\n${requesterName} 님이 ${dateLabel(date)} ${roleLabel} 당번을 대신 해주실 분을 찾고 있어요. 😢🙏` } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '✅ 수락' }, style: 'primary', action_id: 'delegate_accept', value: actionValue },
        { type: 'button', text: { type: 'plain_text', text: '❌ 거절' }, style: 'danger', action_id: 'delegate_decline', value: actionValue },
      ]},
    ],
  });
  await replaceSourceMessage({ body, client, respond, text: `✅ *${dateLabel(date)}* ${roleLabel} 대리 요청을 주간 스레드에 올렸어요.` });
});

// ─── 요청 방식: 날짜 교체 (모달로 날짜 입력) ──────────
app.action('req_swap', async ({ body, ack, client, respond }) => {
  await ack();
  const team = teamForAction(body.channel?.id, 'req_swap');
  if (!team) return;
  const { date, role } = JSON.parse(body.actions[0].value);
  const roleLabel = role === 'check' ? '크첵' : '메인';
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal', callback_id: 'swap_modal',
      // 모달 제출에는 채널 정보가 없으므로 팀 판별용으로 채널을 실어 보낸다
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
  await replaceSourceMessage({ body, client, respond, text: '🔄 날짜 교체 요청 창을 열었어요. (창에서 날짜를 입력하세요)' });
});

// 날짜 교체 모달 제출 → 같은 팀의 상대 당번에게 태그해 팀 주간 스레드에 공지
app.view('swap_modal', async ({ body, ack, view }) => {
  const { date, role, channel } = JSON.parse(view.private_metadata);
  const team = teamForAction(channel, 'swap_modal');
  if (!team) {
    await ack({ response_action: 'errors', errors: { swap_date: UNREGISTERED_CHANNEL_TEXT } });
    return;
  }
  const raw = (view.state.values['swap_date']?.['picked']?.value || '').trim();
  const date2 = parseDate(raw);
  if (!date2) { await ack({ response_action: 'errors', errors: { swap_date: '날짜 형식은 MM.DD 예요 (예: 07.21)' } }); return; }
  if (date2 === date) { await ack({ response_action: 'errors', errors: { swap_date: '같은 날짜로는 교체할 수 없어요.' } }); return; }

  const roleLabel = role === 'check' ? '크첵' : '메인';
  const counterpart = role === 'check' ? getCheck(team, date2).name : getMain(team, date2).name;
  if (!counterpart || counterpart === 'NONE') {
    await ack({ response_action: 'errors', errors: { swap_date: `그 날짜에 ${roleLabel} 당번이 없어요.` } });
    return;
  }
  await ack();

  const requesterName = memberNameById(team, body.user.id) || await getRealName(app.client, body.user.id);
  const actionValue = JSON.stringify({ date, date2, role, requester: requesterName, counterpart });
  await postWeeklyReply(team, {
    text: `🔄 ${dateLabel(date)} ↔ ${dateLabel(date2)} 날짜 교체 요청`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${mentionTag(team, counterpart)}\n${requesterName} 님이 날짜 교체를 요청해요. 😢🙏\n${dateLabel(date)} ${requesterName} ↔ ${dateLabel(date2)} ${counterpart}` } },
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
  const team = teamForAction(body.channel?.id, 'delegate_accept');
  if (!team) return;
  const { date, requester, role } = JSON.parse(body.actions[0].value);
  const acceptor = memberNameById(team, body.user.id) || await getRealName(app.client, body.user.id);
  const roleLabel = role === 'check' ? '크첵' : '메인';
  team.overrides[`${date}:${role === 'check' ? 'check' : 'main'}`] = acceptor;
  await syncOverrideRow(team, date);
  await client.chat.update({
    channel: body.channel.id, ts: body.message.ts, text: `✅ 당번 교체 완료`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ *${dateLabel(date)}* ${roleLabel} 당번이 ${acceptor} 님으로 변경됐어요. ${requester} → ${acceptor}` } }],
  });
  await updateWeeklyThread(team);
  console.log(`[대리요청][${team.label}] 수락 date=${date} role=${role} ${requester} → ${acceptor}`);
});

app.action('delegate_decline', async ({ body, ack }) => {
  await ack();
  const team = teamForAction(body.channel?.id, 'delegate_decline');
  if (!team) return;
  const decliner = memberNameById(team, body.user.id) || await getRealName(app.client, body.user.id);
  // 요청 메시지가 이미 주간 스레드 안에 있으므로 그 ts 를 thread_ts 로 쓰면
  // 스레드 중첩이 된다 — 주간 스레드에 직접 답글로 단다
  await postWeeklyReply(team, { text: randomDecline(decliner) });
  console.log(`[대리요청][${team.label}] 거절 user=${body.user.id} name=${decliner}`);
});

// ─── 날짜 교체 수락/거절 ──────────────────────────────
app.action('swap_accept', async ({ body, ack, client }) => {
  await ack();
  const team = teamForAction(body.channel?.id, 'swap_accept');
  if (!team) return;
  const { date, date2, role, requester, counterpart } = JSON.parse(body.actions[0].value);
  const roleKey = role === 'check' ? 'check' : 'main';
  team.overrides[`${date}:${roleKey}`] = counterpart;
  team.overrides[`${date2}:${roleKey}`] = requester;
  await syncOverrideRow(team, date);
  await syncOverrideRow(team, date2);
  await client.chat.update({
    channel: body.channel.id, ts: body.message.ts, text: `✅ 날짜 교체 완료`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ *${dateLabel(date)}* ↔ *${dateLabel(date2)}* 교체 완료! ${requester} ↔ ${counterpart}` } }],
  });
  await updateWeeklyThread(team);
  console.log(`[날짜교체][${team.label}] 수락 ${date} ↔ ${date2} role=${role} ${requester} ↔ ${counterpart}`);
});

app.action('swap_decline', async ({ body, ack }) => {
  await ack();
  const team = teamForAction(body.channel?.id, 'swap_decline');
  if (!team) return;
  const decliner = memberNameById(team, body.user.id) || await getRealName(app.client, body.user.id);
  await postWeeklyReply(team, { text: randomDecline(decliner) });
  console.log(`[날짜교체][${team.label}] 거절 user=${body.user.id} name=${decliner}`);
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
  const team = teamForAction(body.channel?.id, 'month_confirm');
  if (!team) return;
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
  const sections = chosen.map(w => `📅 *${w.label}*\n${formatWeekDates(team, w.dates)}`).join('\n\n');
  await client.chat.postMessage({ channel: body.channel.id, thread_ts: threadTs, text: sections });
});

app.action('month_all', async ({ body, ack, client }) => {
  await ack();
  const team = teamForAction(body.channel?.id, 'month_all');
  if (!team) return;
  const anchor = body.actions[0].value;
  const threadTs = body.message.thread_ts || body.message.ts;
  const monthNum = new Date(anchor).getMonth() + 1;
  await markMonthSelectDone(client, body, monthNum);
  const sections = getMonthWeeks(anchor).map(w => `📅 *${w.label}*\n${formatWeekDates(team, w.dates)}`).join('\n\n');
  await client.chat.postMessage({ channel: body.channel.id, thread_ts: threadTs, text: `📅 *${monthNum}월 전체 당번 일정*\n\n${sections}` });
});

// ─── 자동 알림 공통 ───────────────────────────────────
// 팀마다 따로 보낸다. 운영 전(루프 비었거나 시작일 전) 팀은 아무것도 보내지 않고,
// 한 팀이 실패해도 다른 팀 알림은 나간다.
async function forEachOperatingTeam(jobName, fn) {
  for (const team of TEAMS) {
    if (!team.channel) {
      console.warn(`[${jobName}][${team.label}] 채널 미설정 — 건너뜀`);
      continue;
    }
    if (!isOperating(team)) {
      console.log(`[${jobName}][${team.label}] 운영 전 — 건너뜀 (루프 ${team.sheetCache.loop.length}칸, 시작일 ${team.sheetCache.startDate || '없음'})`);
      continue;
    }
    try {
      await fn(team);
    } catch (e) {
      console.error(`[${jobName}][${team.label}] 실패:`, e.data?.error || e.message);
    }
  }
}

// ─── 매주 월요일 07:00 — 새 주간 스레드 생성 ──────────
cron.schedule(CONFIG.weeklyTime, () => forEachOperatingTeam('주간스레드', async (team) => {
  const today = todayStr();
  const weekLabel = getWeekLabel(today);
  const res = await app.client.chat.postMessage({
    channel: team.channel,
    text: `📅 *${weekLabel} 당번 일정*\n\n${weeklyMessage(team, today)}`,
  });
  try {
    await setThreadTs(team, res.ts);
  } catch (e) {
    console.error(`[${team.label}] Railway 환경변수 업데이트 실패:`, e.message);
  }
}), { timezone: 'Asia/Seoul' });

// ─── 매일 07:30 — 오늘 당번 알림 + 태그 ──────────────
cron.schedule(CONFIG.notifyTime, () => forEachOperatingTeam('오늘알림', async (team) => {
  const today = todayStr();
  const ts = await ensureWeeklyThread(team);
  await app.client.chat.postMessage({
    channel: team.channel,
    thread_ts: ts,
    text: dutyMessage(team, today, true),
  });
}), { timezone: 'Asia/Seoul' });

// ─── 매일 18:00 — 내일 당번 예고 + 태그 ──────────────
cron.schedule(CONFIG.eveningNotifyTime, () => forEachOperatingTeam('내일예고', async (team) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const ts = await ensureWeeklyThread(team);
  await app.client.chat.postMessage({
    channel: team.channel,
    thread_ts: ts,
    text: eveningMessage(team, tomorrowStr, true),
  });
}), { timezone: 'Asia/Seoul' });

// ─── @당번봇 멘션 처리 ────────────────────────────────
// 어떤 경로로 빠져나가든 사용자에게 응답이 가도록 래퍼로 감싼다
app.event('app_mention', async ({ event, client, say }) => {
  const threadTs = event.thread_ts || event.ts;
  console.log(`[멘션] 수신 user=${event.user} ch=${event.channel} thread=${threadTs} text="${event.text}"`);
  try {
    await handleMention({ event, client, say });
    console.log(`[멘션] 처리 완료 user=${event.user}`);
  } catch (e) {
    console.error(`[멘션] 처리 실패 user=${event.user} text="${event.text}":`, e);
    try {
      await say({
        text: `⚠️ 명령을 처리하다 오류가 났어요.\n\`\`\`${e.data?.error || e.message}\`\`\`\n잠시 후 다시 시도하거나 \`@당번봇 캐시갱신\` 후 재시도해주세요.`,
        thread_ts: threadTs,
      });
    } catch (e2) {
      console.error('[멘션] 오류 응답조차 실패:', e2.data?.error || e2.message);
    }
  }
});

// 나에게만 보이는 메시지. 스레드에서도 보이도록 thread_ts를 넣고,
// 실패하면 스레드 메시지로 폴백해서 "무응답"이 되지 않게 한다.
async function replyEphemeral({ client, say, event, threadTs, text, blocks }) {
  const payload = { channel: event.channel, user: event.user, thread_ts: threadTs, text };
  if (blocks) payload.blocks = blocks;
  try {
    await client.chat.postEphemeral(payload);
    console.log(`[응답] ephemeral 전송 성공 user=${event.user} ch=${event.channel}`);
    return true;
  } catch (e) {
    console.error(`[응답] ephemeral 전송 실패 (${e.data?.error || e.message}) — 스레드 메시지로 폴백`);
    const fallback = { text, thread_ts: threadTs };
    if (blocks) fallback.blocks = blocks;
    await say(fallback);
    console.log(`[응답] 폴백 스레드 메시지 전송 완료 user=${event.user}`);
    return false;
  }
}

async function handleMention({ event, client, say }) {
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const cmd = parts[0];
  const threadTs = event.thread_ts || event.ts;

  const reply = async (msg) => { await say({ text: msg, thread_ts: threadTs }); };

  // 팀은 멘션이 들어온 채널로 정한다
  const team = teamByChannel(event.channel);
  if (!team) {
    console.log(`[멘션] 등록되지 않은 채널 ch=${event.channel}`);
    await reply(UNREGISTERED_CHANNEL_TEXT); return;
  }
  const { overrides } = team;

  // 결과는 팀 주간 스레드에 답글로 남긴다. 명령을 다른 곳에서 쳤다면
  // 무응답으로 보이지 않도록 그 자리에도 위치를 알려준다.
  const replyWeekly = async (msg, blocks) => {
    const { weeklyTs } = await postWeeklyReply(team, { text: msg, blocks });
    if (threadTs !== weeklyTs) {
      await replyEphemeral({
        client, say, event, threadTs,
        text: '✅ 처리했어요. 결과는 *주간 당번 일정* 스레드에 답글로 올렸어요.',
      });
    }
  };

  // 매뉴얼 (빈 멘션 포함)
  if (!cmd || cmd === '매뉴얼') {
    await reply(MANUAL_TEXT); return;
  }

  // 캐시갱신 — 명령이 들어온 채널의 팀만 갱신
  if (cmd === '캐시갱신') {
    await reply(`🔄 ${team.label} 시트 캐시 갱신 중...`);
    await refreshAll(team);
    const { sheetCache } = team;
    const pending = isOperating(team) ? '' : `\n${notOperatingText(team)}`;
    await reply(`✅ ${team.label} 캐시 갱신 완료! 멤버 ${Object.keys(sheetCache.members).length}명 / 루프 ${sheetCache.loop.length}칸 / 크첵루프 ${sheetCache.checkLoop.length}칸 / 변경 ${upcomingOverrideCount(team)}건 / 연차 ${upcomingLeaveCount(team)}명${pending}`);
    return;
  }

  // 여기부터는 당번 데이터가 있어야 하는 명령 — 운영 전이면 안내만 한다
  // (요청/변경/연차는 주간 스레드에 답글을 다는데, 운영 전엔 스레드를 만들지 않는다)
  if (!isOperating(team)) {
    console.log(`[멘션][${team.label}] 운영 전 — cmd="${cmd}" 안내로 응답`);
    await reply(notOperatingText(team)); return;
  }

  // 이번주
  if (cmd === '이번주') {
    const today = todayStr();
    await reply(`📅 *${getWeekLabel(today)} 당번 일정*\n${weeklyMessage(team, today)}`); return;
  }

  // 다음주
  if (cmd === '다음주') {
    const d = new Date(todayStr());
    d.setDate(d.getDate() + 7);
    const nextWeek = d.toLocaleDateString('sv-SE');
    await reply(`📅 *${getWeekLabel(nextWeek)} 당번 일정*\n${weeklyMessage(team, nextWeek)}`); return;
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
    const prevMain = getMain(team, date).name || '—';
    const prevCheck = getCheck(team, date).name;

    if (combinedMatch) {
      const [, mainName, checkName] = combinedMatch;
      overrides[`${date}:main`] = mainName;
      overrides[`${date}:check`] = checkName;
      await syncOverrideRow(team, date);
      await updateWeeklyThread(team);
      const beforeStr = (prevCheck && prevCheck !== 'NONE') ? `${prevMain}(${prevCheck})` : prevMain;
      await replyWeekly(`✅ *${dateLabel(date)}* ${beforeStr} → ${mainName}(${checkName}) 으로 변경했어요.`);
      return;
    }
    overrides[`${date}:main`] = nameInput;
    delete overrides[`${date}:check`];
    await syncOverrideRow(team, date);
    await updateWeeklyThread(team);
    await replyWeekly(`✅ *${dateLabel(date)}* ${prevMain} → ${nameInput} 으로 변경했어요.`);
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
      await syncOverrideRow(team, date);
      await updateWeeklyThread(team);
      await replyWeekly(`↩️ *${dateLabel(date)}* 변경을 취소했어요.`);
    } else {
      await reply(`ℹ️ 변경된 내용이 없어요.`);
    }
    return;
  }

  // 요청 MM.DD — 본인 역할(메인/크첵) 자동 구분 후 요청 방식 선택 (나에게만 표시)
  if (cmd === '요청') {
    console.log(`[요청][${team.label}] 1/4 진입 user=${event.user} args=${JSON.stringify(parts.slice(1))}`);

    const date = parseDate(parts[1] || '');
    if (!date) {
      console.log(`[요청] 중단 — 날짜 파싱 실패 input="${parts[1] || '(없음)'}"`);
      await reply('❌ 사용법: `@당번봇 요청 MM.DD` (예: `@당번봇 요청 08.11`)');
      return;
    }
    console.log(`[요청] 2/4 날짜 파싱 완료 date=${date}`);

    const requesterName = memberNameById(team, event.user);
    console.log(`[요청] 3/4 요청자 조회 user=${event.user} → name=${requesterName || 'null'} (${team.label} 멤버 시트 ${Object.keys(team.sheetCache.members).length}명 로드됨)`);
    if (!requesterName) {
      // 예전엔 여기서 role=null로 흡수돼 원인을 알 수 없었다 — 이제 별도로 안내한다
      await replyEphemeral({
        client, say, event, threadTs,
        text: `❌ ${team.label} 멤버 시트에서 <@${event.user}> 님을 찾지 못했어요.\n시트의 슬랙ID 열을 확인하시고, 방금 수정했다면 \`@당번봇 캐시갱신\` 후 다시 시도해주세요.`,
      });
      return;
    }

    const mainName = getMain(team, date).name || '—';
    const checkName = getCheck(team, date).name || '—';
    const role = requesterRole(team, date, requesterName);
    console.log(`[요청] 4/4 역할 판별 date=${date} 요청자=${requesterName} 메인=${mainName} 크첵=${checkName} → role=${role || 'null'}`);
    if (!role) {
      await replyEphemeral({
        client, say, event, threadTs,
        text: `❌ ${dateLabel(date)} 당번자가 아니에요. 본인 당번날만 요청할 수 있어요.\n(그날 당번: 메인 *${mainName}* / 크첵 *${checkName}*)`,
      });
      return;
    }

    const roleLabel = role === 'main' ? '메인' : '크첵';
    const val = JSON.stringify({ date, role });
    // 주간 스레드에 올라가는 공개 메시지이므로 누구의 요청인지 함께 표시한다
    await replyWeekly(`${requesterName} 님의 ${dateLabel(date)} ${roleLabel} 당번 요청`, [
      { type: 'section', text: { type: 'mrkdwn', text: `🙏 ${mentionTag(team, requesterName)} 님의 *${dateLabel(date)}* ${roleLabel} 당번 요청\n어떤 방식으로 요청할까요?` } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '🙋 대리 요청' }, style: 'primary', action_id: 'req_delegate', value: val },
        { type: 'button', text: { type: 'plain_text', text: '🔄 날짜 교체' }, action_id: 'req_swap', value: val },
      ]},
    ]);
    console.log(`[요청] 완료 — 방식 선택 버튼을 주간 스레드에 전송 date=${date} role=${role}`);
    return;
  }

  // 연차 홍길동 MM.DD~MM.DD
  if (cmd === '연차') {
    const parsed = parts.length === 3 ? parseLeaveArgs(`${parts[1]} ${parts[2]}`) : null;
    if (!parsed) { await reply('❌ 사용법: `@당번봇 연차 홍길동 MM.DD~MM.DD`'); return; }
    const { name, dates, rangeStr } = parsed;
    addLeave(team, name, dates);
    await persistLeaveAdd(team, name, dates[0], dates[dates.length - 1]);
    await replyWeekly(`🏖️ *${name}* 님 연차 등록 완료 (${rangeStr}, ${dates.length}일)`);
    return;
  }

  // 연차취소 홍길동 MM.DD~MM.DD
  if (cmd === '연차취소') {
    const parsed = parts.length === 3 ? parseLeaveArgs(`${parts[1]} ${parts[2]}`) : null;
    if (!parsed) { await reply('❌ 사용법: `@당번봇 연차취소 홍길동 MM.DD~MM.DD`'); return; }
    const { name, dates, rangeStr } = parsed;
    const removed = removeLeave(team, name, dates);
    if (removed > 0) {
      await persistLeaveRemove(team, name, dates[0], dates[dates.length - 1]);
      await replyWeekly(`↩️ *${name}* 님 연차 취소 완료 (${rangeStr}, ${removed}일)`);
    } else {
      await reply(`ℹ️ *${name}* 님의 해당 날짜 연차가 없어요.`);
    }
    return;
  }

  // 연차확인
  if (cmd === '연차확인') {
    await reply(leaveListText(team)); return;
  }

  // MM.DD — 특정 날짜 당번 조회
  const dateQuery = parseDate(cmd);
  if (dateQuery) {
    const { name: main } = getMain(team, dateQuery);
    const { name: check } = getCheck(team, dateQuery);
    const line = main ? formatDutyLine(team, main, check, false) : '—';
    await reply(`📅 *${dateLabel(dateQuery)}* 당번: ${line} 님`); return;
  }

  console.log(`[멘션] 매칭되는 명령어 없음 cmd="${cmd}"`);
  await reply(`❓ 모르는 명령어예요. \`@당번봇 매뉴얼\` 로 사용법을 확인해주세요!`);
}

// ─── 서버 시작 ────────────────────────────────────────
if (require.main === module) {
  (async () => {
    for (const team of TEAMS) {
      if (!team.channel) console.warn(`[시작][${team.label}] 채널 환경변수가 없어요 — 이 팀은 동작하지 않아요`);
      await refreshAll(team, { updateThread: false });
      console.log(`[시작][${team.label}] ch=${team.channel} ${isOperating(team) ? '운영 중' : '운영 전'}`);
    }
    await app.start(process.env.PORT || 3000);
    const authResult = await app.client.auth.test();
    botUserId = authResult.user_id;
    console.log('⚡ 당번 봇이 실행 중입니다! Bot ID:', botUserId);
  })();
}

// 검증 스크립트용 (require 했을 때만 사용, 봇 실행에는 영향 없음)
module.exports = {
  TEAMS, teamByChannel, isOperating, notOperatingText,
  getMain, getCheck, addLeave, removeLeave, isOnLeave,
  upcomingOverrideCount, upcomingLeaveCount,
  weeklyMessage, memberNameById, handleMention, forEachOperatingTeam, ensureWeeklyThread,
  loadSheets,
  _setOverrides: (team, o) => {
    for (const k of Object.keys(team.overrides)) delete team.overrides[k];
    Object.assign(team.overrides, o);
  },
  _setSheetCache: (team, c) => { team.sheetCache = c; invalidateRotation(team); },
  _resetLeaves: (team) => { for (const k of Object.keys(team.leaves)) delete team.leaves[k]; invalidateRotation(team); },
};
