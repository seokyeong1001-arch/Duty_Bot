const { App } = require('@slack/bolt');
const cron = require('node-cron');

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
  return `${mm}/${dd} (${dayNames[d.getDay()]})`;
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
    lines.push(`• ${mm}/${dd} (${day})  ${dutyLine}`);
  }
  return lines.join('\n');
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

---

📌 *슬래시 커맨드*

\`/당번변경 06.04 박지연\`
→ 당번 변경

\`/당번변경 06.04 박지연(이석영)\`
→ 당번+크첵 변경

\`/당번취소 06.04\`
→ 해당 날짜 변경 취소

\`/당번요청 06.04\`
→ 교체 요청

\`/당번연차 문선정 07.14~07.16\`
→ 연차 등록 (단일 날짜: \`07.14\`)

\`/당번연차취소 문선정 07.14~07.16\`
→ 연차 취소

\`/당번연차확인\`
→ 등록된 연차 목록 보기

\`/당번주간\`
→ 이번 주 일정 나만 보기

\`/당번주간 다음주\`
→ 다음 주 일정 나만 보기

\`/당번날짜 06.04\`
→ 특정 날짜 당번 조회

\`/당번매뉴얼\`
→ 이 매뉴얼 보기

---

💬 *멘션 커맨드 (스레드에서도 사용 가능)*

\`@당번봇 당번변경 06.04 박지연\`
\`@당번봇 당번변경 06.04 박지연(이석영)\`
\`@당번봇 당번취소 06.04\`
\`@당번봇 당번요청 06.04\`
\`@당번봇 당번연차 문선정 07.14~07.16\`
\`@당번봇 당번연차취소 문선정 07.14~07.16\`
\`@당번봇 당번연차확인\`
\`@당번봇 당번주간\`
\`@당번봇 당번주간 다음주\`
\`@당번봇 당번날짜 06.04\`
\`@당번봇 당번매뉴얼\`
\`@당번봇 당번캐시갱신\`

---

📅 *자동 알림*

• 매일 07:30 — 오늘 당번 알림 (당번자 태그)
• 매일 18:00 — 내일 당번 예고 (당번자 태그)
• 매주 월요일 07:00 — 주간 스레드 생성

---

🏖️ *연차 처리*

연차 등록 시 해당 날짜의 메인/크첵 당번에서 자동으로 다음 순번으로 대체되며,
알림 메시지에 *(연차 대체)* 표시가 붙어요.`;

// ─── 연차 슬래시 커맨드 공통 파서 ────────────────────
function parseLeaveArgs(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [name, rangeStr] = parts;
  const dates = parseDateRange(rangeStr);
  if (!dates) return null;
  return { name, dates, rangeStr };
}

// ─── /당번변경 ────────────────────────────────────────
app.command('/당번변경', async ({ command, ack, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);
  if (parts.length !== 2) {
    await respond({ text: '❌ 사용법:\n• 메인만: `/당번변경 06.02 박지연`\n• 메인+크첵: `/당번변경 06.02 박지연(이석영)`', response_type: 'ephemeral' }); return;
  }
  const [rawDate, nameInput] = parts;
  const date = parseDate(rawDate);
  if (!date) { await respond({ text: '❌ 날짜 형식: `06.02`', response_type: 'ephemeral' }); return; }

  const combinedMatch = nameInput.match(/^(.+?)\((.+?)\)$/);
  if (combinedMatch) {
    const [, mainName, checkName] = combinedMatch;
    overrides[`${date}:main`] = mainName;
    overrides[`${date}:check`] = checkName;
    await updateWeeklyThread();
    await respond({ text: `✅ *${dateLabel(date)}* 당번 *${mainName}* 님, 크첵 *${checkName}* 님으로 변경했어요.`, response_type: 'in_channel' });
    return;
  }

  overrides[`${date}:main`] = nameInput;
  delete overrides[`${date}:check`];
  await updateWeeklyThread();
  await respond({ text: `✅ *${dateLabel(date)}* 를 *${nameInput}* 님으로 변경했어요.`, response_type: 'in_channel' });
});

// ─── /당번취소 ────────────────────────────────────────
app.command('/당번취소', async ({ command, ack, respond }) => {
  await ack();
  const date = parseDate(command.text.trim());
  if (!date) { await respond({ text: '❌ 날짜 형식: `06.02`', response_type: 'ephemeral' }); return; }

  const keys = [`${date}:main`, `${date}:check`];
  const removed = keys.filter(k => k in overrides);
  removed.forEach(k => delete overrides[k]);

  if (removed.length > 0) {
    await updateWeeklyThread();
    await respond({ text: `↩️ *${dateLabel(date)}* 변경을 취소했어요.`, response_type: 'in_channel' });
  } else {
    await respond({ text: `ℹ️ 변경된 내용이 없어요.`, response_type: 'ephemeral' });
  }
});

// ─── /당번주간 ────────────────────────────────────────
app.command('/당번주간', async ({ command, ack, respond }) => {
  await ack();
  const arg = command.text.trim();
  if (arg === '다음주') {
    const d = new Date(todayStr());
    d.setDate(d.getDate() + 7);
    const nextWeek = d.toLocaleDateString('sv-SE');
    await respond({ text: `📅 *${getWeekLabel(nextWeek)} 당번 일정*\n${weeklyMessage(nextWeek)}`, response_type: 'ephemeral' });
    return;
  }
  const today = todayStr();
  await respond({ text: `📅 *${getWeekLabel(today)} 당번 일정*\n${weeklyMessage(today)}`, response_type: 'ephemeral' });
});

// ─── /당번날짜 ────────────────────────────────────────
app.command('/당번날짜', async ({ command, ack, respond }) => {
  await ack();
  const date = parseDate(command.text.trim());
  if (!date) { await respond({ text: '❌ 날짜 형식: `06.04`', response_type: 'ephemeral' }); return; }
  const { name: main } = getMain(date);
  const { name: check } = getCheck(date);
  const line = main ? formatDutyLine(main, check, false) : '—';
  await respond({ text: `📅 *${dateLabel(date)}* 당번: ${line} 님`, response_type: 'ephemeral' });
});

// ─── /당번다음주 ─────────────────────────────────────
app.command('/당번다음주', async ({ ack, respond }) => {
  await ack();
  const d = new Date(todayStr());
  d.setDate(d.getDate() + 7);
  const nextWeek = d.toLocaleDateString('sv-SE');
  await respond({ text: `📅 *${getWeekLabel(nextWeek)} 당번 일정*\n${weeklyMessage(nextWeek)}`, response_type: 'ephemeral' });
});

// ─── /당번요청 ────────────────────────────────────────
app.command('/당번요청', async ({ command, ack, client, respond }) => {
  await ack();
  const date = parseDate(command.text.trim().split(/\s+/)[0]);
  if (!date) { await respond({ text: '❌ 사용법: `/당번요청 06.02`', response_type: 'ephemeral' }); return; }
  const requester = await getRealName(client, command.user_id);
  const label = dateLabel(date);
  const actionValue = JSON.stringify({ date, requester });
  await client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    text: `🙏 당번 교체 요청`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `🙏 *당번 교체 요청*\n\n*${label}* 당번을 대신 해주실 분 있으신가요?\n요청자: *${requester}* 님` } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '✅ 수락' }, style: 'primary', action_id: 'duty_accept', value: actionValue },
        { type: 'button', text: { type: 'plain_text', text: '❌ 거절' }, style: 'danger', action_id: 'duty_decline', value: actionValue },
      ]},
    ],
  });
  await respond({ text: `📨 *${label}* 교체 요청을 채널에 보냈어요.`, response_type: 'ephemeral' });
});

// ─── /당번연차 ────────────────────────────────────────
app.command('/당번연차', async ({ command, ack, respond }) => {
  await ack();
  const parsed = parseLeaveArgs(command.text);
  if (!parsed) {
    await respond({ text: '❌ 사용법: `/당번연차 문선정 07.14~07.16`', response_type: 'ephemeral' }); return;
  }
  const { name, dates, rangeStr } = parsed;
  addLeave(name, dates);
  await respond({ text: `🏖️ *${name}* 님 연차 등록 완료 (${rangeStr}, ${dates.length}일)`, response_type: 'in_channel' });
});

// ─── /당번연차취소 ────────────────────────────────────
app.command('/당번연차취소', async ({ command, ack, respond }) => {
  await ack();
  const parsed = parseLeaveArgs(command.text);
  if (!parsed) {
    await respond({ text: '❌ 사용법: `/당번연차취소 문선정 07.14~07.16`', response_type: 'ephemeral' }); return;
  }
  const { name, dates, rangeStr } = parsed;
  const removed = removeLeave(name, dates);
  if (removed > 0) {
    await respond({ text: `↩️ *${name}* 님 연차 취소 완료 (${rangeStr}, ${removed}일)`, response_type: 'in_channel' });
  } else {
    await respond({ text: `ℹ️ *${name}* 님의 해당 날짜 연차가 없어요.`, response_type: 'ephemeral' });
  }
});

// ─── /당번연차확인 ────────────────────────────────────
app.command('/당번연차확인', async ({ ack, respond }) => {
  await ack();
  await respond({ text: leaveListText(), response_type: 'ephemeral' });
});

// ─── /당번매뉴얼 ──────────────────────────────────────
app.command('/당번매뉴얼', async ({ ack, respond }) => {
  await ack();
  await respond({ text: MANUAL_TEXT, response_type: 'ephemeral' });
});

// ─── 수락 버튼 ────────────────────────────────────────
app.action('duty_accept', async ({ body, ack, client }) => {
  await ack();
  const { date, requester } = JSON.parse(body.actions[0].value);
  const acceptor = await getRealName(app.client, body.user.id);
  const label = dateLabel(date);
  overrides[`${date}:main`] = acceptor;
  await client.chat.update({
    channel: body.channel.id, ts: body.message.ts, text: `✅ 당번 교체 완료`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ *당번 교체 완료*\n\n*${label}* 당번이 *${acceptor}* 님으로 변경됐어요!\n${requester} 님 → *${acceptor}* 님 🎉` } }],
  });
  await updateWeeklyThread();
});

// ─── 거절 버튼 ────────────────────────────────────────
app.action('duty_decline', async ({ body, ack, client }) => {
  await ack();
  const { date, requester } = JSON.parse(body.actions[0].value);
  const decliner = await getRealName(app.client, body.user.id);
  const label = dateLabel(date);
  await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message.ts, text: `*${decliner}* 님이 *${label}* 교체 요청을 거절했어요.` });
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

  if (!cmd || cmd === '매뉴얼' || cmd === '당번매뉴얼') {
    await reply(MANUAL_TEXT); return;
  }

  if (cmd === '당번캐시갱신') {
    await reply('🔄 시트 캐시 갱신 중...');
    await loadSheets();
    await reply(`✅ 캐시 갱신 완료! 멤버 ${Object.keys(sheetCache.members).length}명 / 루프 ${sheetCache.loop.length}칸 / 크첵루프 ${sheetCache.checkLoop.length}칸`);
    return;
  }

  if (cmd === '당번연차') {
    // @당번봇 당번연차 문선정 07.14~07.16
    const parsed = parts.length === 3 ? parseLeaveArgs(`${parts[1]} ${parts[2]}`) : null;
    if (!parsed) { await reply('❌ 사용법: `@당번봇 당번연차 문선정 07.14~07.16`'); return; }
    const { name, dates, rangeStr } = parsed;
    addLeave(name, dates);
    await reply(`🏖️ *${name}* 님 연차 등록 완료 (${rangeStr}, ${dates.length}일)`);
    return;
  }

  if (cmd === '당번연차취소') {
    const parsed = parts.length === 3 ? parseLeaveArgs(`${parts[1]} ${parts[2]}`) : null;
    if (!parsed) { await reply('❌ 사용법: `@당번봇 당번연차취소 문선정 07.14~07.16`'); return; }
    const { name, dates, rangeStr } = parsed;
    const removed = removeLeave(name, dates);
    if (removed > 0) {
      await reply(`↩️ *${name}* 님 연차 취소 완료 (${rangeStr}, ${removed}일)`);
    } else {
      await reply(`ℹ️ *${name}* 님의 해당 날짜 연차가 없어요.`);
    }
    return;
  }

  if (cmd === '당번연차확인') {
    await reply(leaveListText()); return;
  }

  if (cmd === '당번주간') {
    if (parts[1] === '다음주') {
      const d = new Date(todayStr());
      d.setDate(d.getDate() + 7);
      const nextWeek = d.toLocaleDateString('sv-SE');
      await reply(`📅 *${getWeekLabel(nextWeek)} 당번 일정*\n${weeklyMessage(nextWeek)}`); return;
    }
    const today = todayStr();
    await reply(`📅 *${getWeekLabel(today)} 당번 일정*\n${weeklyMessage(today)}`); return;
  }

  if (cmd === '당번날짜') {
    const date = parseDate(parts[1] || '');
    if (!date) { await reply('❌ 날짜 형식: `06.04`'); return; }
    const { name: main } = getMain(date);
    const { name: check } = getCheck(date);
    const line = main ? formatDutyLine(main, check, false) : '—';
    await reply(`📅 *${dateLabel(date)}* 당번: ${line} 님`); return;
  }

  if (cmd === '당번변경') {
    if (parts.length !== 3) { await reply('❌ 사용법:\n• `@당번봇 당번변경 06.04 박지연`\n• `@당번봇 당번변경 06.04 박지연(이석영)`'); return; }
    const date = parseDate(parts[1]);
    if (!date) { await reply('❌ 날짜 형식: `06.04`'); return; }
    const nameInput = parts[2];
    const combinedMatch = nameInput.match(/^(.+?)\((.+?)\)$/);
    if (combinedMatch) {
      const [, mainName, checkName] = combinedMatch;
      overrides[`${date}:main`] = mainName;
      overrides[`${date}:check`] = checkName;
      await updateWeeklyThread();
      await reply(`✅ *${dateLabel(date)}* 당번 *${mainName}* 님, 크첵 *${checkName}* 님으로 변경했어요.`);
      return;
    }
    overrides[`${date}:main`] = nameInput;
    delete overrides[`${date}:check`];
    await updateWeeklyThread();
    await reply(`✅ *${dateLabel(date)}* 를 *${nameInput}* 님으로 변경했어요.`);
    return;
  }

  if (cmd === '당번취소') {
    const date = parseDate(parts[1] || '');
    if (!date) { await reply('❌ 날짜 형식: `06.04`'); return; }
    const keys = [`${date}:main`, `${date}:check`];
    const removed = keys.filter(k => k in overrides);
    removed.forEach(k => delete overrides[k]);
    if (removed.length > 0) {
      await updateWeeklyThread();
      await reply(`↩️ *${dateLabel(date)}* 변경을 취소했어요.`);
    } else {
      await reply(`ℹ️ 변경된 내용이 없어요.`);
    }
    return;
  }

  if (cmd === '당번요청') {
    const date = parseDate(parts[1] || '');
    if (!date) { await reply('❌ 사용법: `@당번봇 당번요청 06.04`'); return; }
    const requesterName = await getRealName(client, event.user);
    const label = dateLabel(date);
    const actionValue = JSON.stringify({ date, requester: requesterName });
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: `🙏 당번 교체 요청`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `🙏 *당번 교체 요청*\n\n*${label}* 당번을 대신 해주실 분 있으신가요?\n요청자: *${requesterName}* 님` } },
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: '✅ 수락' }, style: 'primary', action_id: 'duty_accept', value: actionValue },
          { type: 'button', text: { type: 'plain_text', text: '❌ 거절' }, style: 'danger', action_id: 'duty_decline', value: actionValue },
        ]},
      ],
    });
    return;
  }

  await reply(`❓ 모르는 명령어예요. \`@당번봇 당번매뉴얼\` 로 사용법을 확인해주세요!`);
});

// ─── 서버 시작 ────────────────────────────────────────
(async () => {
  await loadSheets();
  await app.start(process.env.PORT || 3000);
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id;
  console.log('⚡ 당번 봇이 실행 중입니다! Bot ID:', botUserId);
})();
