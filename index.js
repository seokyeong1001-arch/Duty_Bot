const { App } = require('@slack/bolt');
const cron = require('node-cron');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// ─── 설정 (여기만 수정) ───────────────────────────────
const CONFIG = {
  startDate: '2026-06-01', // 파인트/스틱바 2루프 시작일
  notifyChannel: process.env.SLACK_CHANNEL,
  notifyTime: '30 7 * * *',
  weeklyTime: '30 7 * * 1',
  eveningNotifyTime: '0 18 * * *',

  // 파인트 루프: 고가영 ↔ 박지연 하루씩 교대
  pint: ['고가영', '박지연'],
  // 스틱바 루프: 문선정 ↔ 김유진 하루씩 교대
  stick: ['문선정', '김유진'],

  // 크첵 패턴 (박지연/김유진 당번날에만 붙음)
  // 파인트 크첵: 이석영 → 고가영 → 이석영 → 고가영 ...
  pintCheck: ['이석영', '고가영'],
  // 스틱바 크첵: 문선정 → 이석영 → 문선정 → 이석영 ...
  stickCheck: ['문선정', '이석영'],

  memberIds: {
    '고가영': 'U0A4DMQ1D99',
    '박지연': 'U0AMT81HV42',
    '문선정': 'U07N2D1DYE6',
    '김유진': 'U0AMPR3Q09K',
    '이석영': 'U06TTAA85TQ',
  },

  // 6월 이전 단일 루프 설정
  legacyStartDate: '2026-05-25',
  legacyMembers: ['문선정', '고가영', '이석영'],
  legacyEndDate: '2026-05-31',
};
// ─────────────────────────────────────────────────────

const overrides = {};
let botUserId = null; // { 'YYYY-MM-DD:pint': '이름', 'YYYY-MM-DD:stick': '이름' }
let weeklyThreadTs = null;

function getWeekLabel(dateStr) {
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;
  const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
  const week = Math.ceil((d.getDate() + firstDay.getDay()) / 7);
  return `${month}월 ${week}주차`;
}

function parseDate(input) {
  const today = new Date();
  const year = today.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 4);
  const match = input.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (!match) return null;
  const mm = match[1].padStart(2, '0');
  const dd = match[2].padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

async function getRealName(client, userId) {
  try {
    const res = await client.users.info({ user: userId });
    return res.user.profile.display_name || res.user.profile.real_name || res.user.name;
  } catch {
    return userId;
  }
}

function dayDiff(dateStr) {
  const start = new Date(CONFIG.startDate);
  const target = new Date(dateStr);
  return Math.round((target - start) / (1000 * 60 * 60 * 24));
}

// 5/25~5/31 단일 루프
function getLegacyMember(dateStr) {
  const start = new Date(CONFIG.legacyStartDate);
  const target = new Date(dateStr);
  const diff = Math.round((target - start) / (1000 * 60 * 60 * 24));
  if (diff < 0) return null;
  return CONFIG.legacyMembers[diff % CONFIG.legacyMembers.length];
}

function isLegacyDate(dateStr) {
  return dateStr >= CONFIG.legacyStartDate && dateStr <= CONFIG.legacyEndDate;
}

// 파인트 당번 (가영=짝수일, 지연=홀수일)
function getPintMain(dateStr) {
  if (overrides[`${dateStr}:pint`]) return overrides[`${dateStr}:pint`];
  const diff = dayDiff(dateStr);
  return diff < 0 ? null : CONFIG.pint[diff % 2];
}

// 스틱바 당번 (선정=짝수일, 유진=홀수일)
function getStickMain(dateStr) {
  if (overrides[`${dateStr}:stick`]) return overrides[`${dateStr}:stick`];
  const diff = dayDiff(dateStr);
  return diff < 0 ? null : CONFIG.stick[diff % 2];
}

// 파인트 크첵 (지연 당번날에만, 석영→가영→석영→가영...)
// 지연 당번날 = 홀수일, 크첵 순번은 홀수일 중 몇 번째인지로 계산
function getPintCheck(dateStr) {
  if (overrides[`${dateStr}:pintCheck`]) return overrides[`${dateStr}:pintCheck`];
  const diff = dayDiff(dateStr);
  if (diff < 0 || diff % 2 === 0) return null; // 가영 당번날은 크첵 없음
  const checkIdx = Math.floor(diff / 2); // 지연 당번 횟수
  return CONFIG.pintCheck[checkIdx % CONFIG.pintCheck.length];
}

// 스틱바 크첵 (유진 당번날에만, 선정→석영→선정→석영...)
function getStickCheck(dateStr) {
  if (overrides[`${dateStr}:stickCheck`]) return overrides[`${dateStr}:stickCheck`];
  const diff = dayDiff(dateStr);
  if (diff < 0 || diff % 2 === 0) return null; // 선정 당번날은 크첵 없음
  const checkIdx = Math.floor(diff / 2);
  return CONFIG.stickCheck[checkIdx % CONFIG.stickCheck.length];
}

function mentionTag(name) {
  const id = CONFIG.memberIds[name];
  return id ? `<@${id}>` : `*${name}*`;
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function dateLabel(dateStr) {
  const d = new Date(dateStr);
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const [, mm, dd] = dateStr.split('-');
  return `${mm}/${dd} (${dayNames[d.getDay()]})`;
}

function formatDutyLine(main, check, withTag) {
  const mainText = withTag ? mentionTag(main) : `*${main}*`;
  if (check) {
    const checkText = withTag ? mentionTag(check) : `*${check}*`;
    return `${mainText} (${checkText})`;
  }
  return mainText;
}

function dutyMessage(dateStr, withTag = false) {
  const label = dateLabel(dateStr);
  if (isLegacyDate(dateStr)) {
    const member = getLegacyMember(dateStr);
    const memberText = member ? (withTag ? mentionTag(member) : `*${member}*`) : '—';
    return `🔔 *[당번 알림]* ${label}\n\n오늘 당번은 ${memberText} 님입니다! 수고해주세요 💪`;
  }
  const pintMain = getPintMain(dateStr);
  const stickMain = getStickMain(dateStr);
  const pintCheck = getPintCheck(dateStr);
  const stickCheck = getStickCheck(dateStr);
  const pintLine = pintMain ? formatDutyLine(pintMain, pintCheck, withTag) : '—';
  const stickLine = stickMain ? formatDutyLine(stickMain, stickCheck, withTag) : '—';
  return `🔔 *[당번 알림]* ${label}\n\n📍 파인트: ${pintLine}\n📍 스틱바: ${stickLine}\n\n수고해주세요 💪`;
}

function eveningMessage(tomorrowStr, withTag = false) {
  const label = dateLabel(tomorrowStr);
  if (isLegacyDate(tomorrowStr)) {
    const member = getLegacyMember(tomorrowStr);
    const memberText = member ? (withTag ? mentionTag(member) : `*${member}*`) : '—';
    return `🌙 *[내일 당번 예고]* ${label}\n\n내일 당번은 ${memberText} 님입니다!`;
  }
  const pintMain = getPintMain(tomorrowStr);
  const stickMain = getStickMain(tomorrowStr);
  const pintCheck = getPintCheck(tomorrowStr);
  const stickCheck = getStickCheck(tomorrowStr);
  const pintLine = pintMain ? formatDutyLine(pintMain, pintCheck, withTag) : '—';
  const stickLine = stickMain ? formatDutyLine(stickMain, stickCheck, withTag) : '—';
  return `🌙 *[내일 당번 예고]* ${label}\n\n📍 파인트: ${pintLine}\n📍 스틱바: ${stickLine}`;
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
    let line;
    if (isLegacyDate(ds)) {
      const member = getLegacyMember(ds) || '—';
      line = `• ${mm}/${dd} (${day})  ${member}`;
    } else {
      const pintMain = getPintMain(ds) || '—';
      const stickMain = getStickMain(ds) || '—';
      const pintCheck = getPintCheck(ds);
      const stickCheck = getStickCheck(ds);
      const pintLine = pintCheck ? `${pintMain} (${pintCheck})` : pintMain;
      const stickLine = stickCheck ? `${stickMain} (${stickCheck})` : stickMain;
      line = `• ${mm}/${dd} (${day})  파인트: ${pintLine}  |  스틱바: ${stickLine}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}


const MANUAL_TEXT = `📖 *당번봇 매뉴얼*

*📌 슬래시 커맨드*
\`/당번변경 06.04 파인트 박지연\` — 파인트 메인 변경
\`/당번변경 06.04 파인트 박지연(이석영)\` — 파인트 메인+크첵 변경
\`/당번취소 06.04 파인트\` — 파인트 변경 취소
\`/당번취소 06.04 스틱바\` — 스틱바 변경 취소
\`/당번취소 06.04\` — 해당 날짜 전체 취소
\`/당번요청 06.04 파인트\` — 파인트 교체 요청
\`/당번주간\` — 이번 주 일정 나만 보기
\`/당번날짜 06.04\` — 특정 날짜 당번 조회
\`/당번매뉴얼\` — 이 매뉴얼 보기

*💬 멘션 커맨드 (스레드에서도 사용 가능)*
\`@당번봇 변경 06.04 파인트 박지연\`
\`@당번봇 변경 06.04 파인트 박지연(이석영)\`
\`@당번봇 취소 06.04 파인트\`
\`@당번봇 요청 06.04 파인트\`
\`@당번봇 주간\`
\`@당번봇 날짜 06.04\`
\`@당번봇 매뉴얼\`

*📅 자동 알림*
• 매일 07:30 — 오늘 당번 알림 (당번자 태그)
• 매일 18:00 — 내일 당번 예고 (당번자 태그)
• 매주 월요일 07:30 — 주간 스레드 생성`;


// 주간 스레드 원본 메시지 업데이트
async function updateWeeklyThread() {
  if (!weeklyThreadTs) return;
  try {
    const today = todayStr();
    // 스레드 시작일 기준으로 그 주 월요일 찾기
    const threadDate = new Date(parseFloat(weeklyThreadTs) * 1000);
    const threadDateStr = threadDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const d = new Date(threadDateStr);
    const dow = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    const mondayStr = monday.toLocaleDateString('sv-SE');
    const weekLabel = getWeekLabel(mondayStr);
    await app.client.chat.update({
      channel: CONFIG.notifyChannel,
      ts: weeklyThreadTs,
      text: `📅 *${weekLabel} 당번 일정*\n\n${weeklyMessage(mondayStr)}`,
    });
  } catch (e) {
    console.error('주간 스레드 업데이트 실패:', e.message);
  }
}

async function ensureWeeklyThread() {
  if (weeklyThreadTs) return;
  const today = todayStr();
  const weekLabel = getWeekLabel(today);
  const res = await app.client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    text: `📅 *${weekLabel} 당번 일정*\n\n${weeklyMessage(today)}`,
  });
  weeklyThreadTs = res.ts;
}

// ─── /당번변경 ────────────────────────────────────────
// 메인만: /당번변경 06.02 파인트 박지연
// 메인+크첵: /당번변경 06.02 파인트 박지연(이석영)
app.command('/당번변경', async ({ command, ack, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);
  if (parts.length !== 3) {
    await respond({ text: '❌ 사용법:\n• 메인만: `/당번변경 06.02 파인트 박지연`\n• 메인+크첵: `/당번변경 06.02 파인트 박지연(이석영)`', response_type: 'ephemeral' }); return;
  }
  const [rawDate, loop, nameInput] = parts;
  const date = parseDate(rawDate);
  if (!date) { await respond({ text: '❌ 날짜 형식: `06.02`', response_type: 'ephemeral' }); return; }

  const loopKeyMap = { '파인트': 'pint', '스틱바': 'stick' };
  const key = loopKeyMap[loop];
  if (!key) {
    await respond({ text: '❌ 루프는 `파인트` 또는 `스틱바`로 입력해주세요.', response_type: 'ephemeral' }); return;
  }

  // 메인(크첵) 형태 파싱
  const combinedMatch = nameInput.match(/^(.+?)\((.+?)\)$/);
  if (combinedMatch) {
    const [, mainName, checkName] = combinedMatch;
    const checkKeyMap = { 'pint': 'pintCheck', 'stick': 'stickCheck' };
    overrides[`${date}:${key}`] = mainName;
    overrides[`${date}:${checkKeyMap[key]}`] = checkName;
    await respond({ text: `✅ *${dateLabel(date)} ${loop}* 당번 *${mainName}* 님, 크첵 *${checkName}* 님으로 변경했어요.`, response_type: 'in_channel' });
    return;
  }

  overrides[`${date}:${key}`] = nameInput;
  // 메인만 변경 시 해당 루프 크첵도 초기화
  const checkKeyMap2 = { 'pint': 'pintCheck', 'stick': 'stickCheck' };
  if (checkKeyMap2[key]) delete overrides[`${date}:${checkKeyMap2[key]}`];
  await respond({ text: `✅ *${dateLabel(date)} ${loop}* 을 *${nameInput}* 님으로 변경했어요.`, response_type: 'in_channel' });
});

// ─── /당번취소 ────────────────────────────────────────
app.command('/당번취소', async ({ command, ack, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);
  const rawDate = parts[0];
  const loop = parts[1] || null;
  const date = parseDate(rawDate);
  if (!date) { await respond({ text: '❌ 날짜 형식: `06.02`', response_type: 'ephemeral' }); return; }

  const loopKeyMap = { '파인트': 'pint', '스틱바': 'stick' };

  if (loop) {
    const key = loopKeyMap[loop];
    if (!key) {
      await respond({ text: '❌ 루프는 `파인트` 또는 `스틱바`로 입력해주세요.', response_type: 'ephemeral' }); return;
    }
    const overrideKey = `${date}:${key}`;
    if (overrides[overrideKey]) { delete overrides[overrideKey]; await respond({ text: `↩️ *${dateLabel(date)} ${loop}* 변경을 취소했어요.`, response_type: 'in_channel' }); }
    else await respond({ text: `ℹ️ 변경된 내용이 없어요.`, response_type: 'ephemeral' });
    return;
  }

  const removed = [];
  [`${date}:pint`, `${date}:stick`, `${date}:pintCheck`, `${date}:stickCheck`].forEach(k => {
    if (overrides[k]) { delete overrides[k]; removed.push(k); }
  });
  if (removed.length > 0) { await updateWeeklyThread(); await respond({ text: `↩️ *${dateLabel(date)}* 전체 변경을 취소했어요.`, response_type: 'in_channel' }); }
  else await respond({ text: `ℹ️ 변경된 내용이 없어요.`, response_type: 'ephemeral' });
});

// ─── /당번주간 ────────────────────────────────────────
app.command('/당번주간', async ({ ack, respond }) => {
  await ack();
  const today = todayStr();
  const label = getWeekLabel(today);
  await respond({ text: `📅 *${label} 당번 일정*\n${weeklyMessage(today)}`, response_type: 'ephemeral' });
});

// ─── /당번날짜 : 특정 날짜 당번 조회 ─────────────────
app.command('/당번날짜', async ({ command, ack, respond }) => {
  await ack();
  const rawDate = command.text.trim();
  const date = parseDate(rawDate);
  if (!date) {
    await respond({ text: '❌ 날짜 형식: `06.04`', response_type: 'ephemeral' }); return;
  }
  let text;
  if (isLegacyDate(date)) {
    const member = getLegacyMember(date) || '—';
    text = `📅 *${dateLabel(date)}* 당번: *${member}* 님`;
  } else {
    const pintMain = getPintMain(date) || '—';
    const stickMain = getStickMain(date) || '—';
    const pintCheck = getPintCheck(date);
    const stickCheck = getStickCheck(date);
    const pintLine = pintCheck ? `${pintMain} (${pintCheck})` : pintMain;
    const stickLine = stickCheck ? `${stickMain} (${stickCheck})` : stickMain;
    text = `📅 *${dateLabel(date)}*\n\n📍 파인트: ${pintLine}\n📍 스틱바: ${stickLine}`;
  }
  await respond({ text, response_type: 'ephemeral' });
});

// ─── /당번요청 ────────────────────────────────────────
app.command('/당번요청', async ({ command, ack, client, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);
  const rawDate = parts[0];
  const loop = parts[1] || null;
  const date = parseDate(rawDate);
  if (!date) { await respond({ text: '❌ 사용법: `/당번요청 06.02 파인트`', response_type: 'ephemeral' }); return; }
  if (loop && loop !== '파인트' && loop !== '스틱바') {
    await respond({ text: '❌ 루프는 `파인트` 또는 `스틱바`로 입력해주세요.', response_type: 'ephemeral' }); return;
  }
  const loopText = loop ? ` ${loop}` : '';
  const requester = await getRealName(client, command.user_id);
  const label = dateLabel(date);
  const actionValue = JSON.stringify({ date, loop: loop || null, requester });
  await client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    text: `🙏 당번 교체 요청`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `🙏 *당번 교체 요청*\n\n*${label}${loopText}* 당번을 대신 해주실 분 있으신가요?\n요청자: *${requester}* 님` } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '✅ 수락' }, style: 'primary', action_id: 'duty_accept', value: actionValue },
        { type: 'button', text: { type: 'plain_text', text: '❌ 거절' }, style: 'danger', action_id: 'duty_decline', value: actionValue },
      ]},
    ],
  });
  await respond({ text: `📨 *${label}${loopText}* 교체 요청을 채널에 보냈어요.`, response_type: 'ephemeral' });
});

// ─── 수락 버튼 ───────────────────────────────────────
app.action('duty_accept', async ({ body, ack, client }) => {
  await ack();
  const { date, loop, requester } = JSON.parse(body.actions[0].value);
  const acceptor = await getRealName(app.client, body.user.id);
  const label = dateLabel(date);
  const loopText = loop ? ` ${loop}` : '';
  if (loop) {
    const key = loop === '파인트' ? 'pint' : 'stick';
    overrides[`${date}:${key}`] = acceptor;
  } else {
    overrides[`${date}:pint`] = acceptor;
    overrides[`${date}:stick`] = acceptor;
  }
  await client.chat.update({
    channel: body.channel.id, ts: body.message.ts, text: `✅ 당번 교체 완료`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ *당번 교체 완료*\n\n*${label}${loopText}* 당번이 *${acceptor}* 님으로 변경됐어요!\n${requester} 님 → *${acceptor}* 님 🎉` } }],
  });
});

// ─── 거절 버튼 ───────────────────────────────────────
app.action('duty_decline', async ({ body, ack, client }) => {
  await ack();
  const { date, loop, requester } = JSON.parse(body.actions[0].value);
  const decliner = await getRealName(app.client, body.user.id);
  const label = dateLabel(date);
  const loopText = loop ? ` ${loop}` : '';
  await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message.ts, text: `*${decliner}* 님이 *${label}${loopText}* 교체 요청을 거절했어요.` });
});

// ─── /당번매뉴얼 ─────────────────────────────────────
app.command('/당번매뉴얼', async ({ ack, respond }) => {
  await ack();
  await respond({ text: MANUAL_TEXT, response_type: 'ephemeral' });
});

// ─── 매주 월요일 07:30 — 새 주간 스레드 생성 ─────────
cron.schedule(CONFIG.weeklyTime, async () => {
  const today = todayStr();
  const weekLabel = getWeekLabel(today);
  const res = await app.client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    text: `📅 *${weekLabel} 당번 일정*\n\n${weeklyMessage(today)}`,
  });
  weeklyThreadTs = res.ts;
}, { timezone: 'Asia/Seoul' });

// ─── 매일 07:30 — 오늘 당번 알림 + 태그 ─────────────
cron.schedule(CONFIG.notifyTime, async () => {
  const today = todayStr();
  await ensureWeeklyThread();
  await app.client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    thread_ts: weeklyThreadTs,
    text: dutyMessage(today, true),
  });
}, { timezone: 'Asia/Seoul' });

// ─── 매일 18:00 — 내일 당번 예고 + 태그 ─────────────
cron.schedule(CONFIG.eveningNotifyTime, async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  await ensureWeeklyThread();
  await app.client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    thread_ts: weeklyThreadTs,
    text: eveningMessage(tomorrowStr, true),
  });
}, { timezone: 'Asia/Seoul' });

// ─── @당번봇 멘션 처리 ───────────────────────────────
app.event('app_mention', async ({ event, client, say }) => {
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const cmd = parts[0];
  const threadTs = event.thread_ts || event.ts;

  const reply = async (msg) => {
    await say({ text: msg, thread_ts: threadTs });
  };

  // 매뉴얼
  if (!cmd || cmd === '매뉴얼') {
    await reply(MANUAL_TEXT); return;
  }

  // 주간
  if (cmd === '주간') {
    const today = todayStr();
    const label = getWeekLabel(today);
    await reply(`📅 *${label} 당번 일정*\n${weeklyMessage(today)}`); return;
  }

  // 날짜
  if (cmd === '날짜') {
    const rawDate = parts[1];
    const date = parseDate(rawDate);
    if (!date) { await reply('❌ 날짜 형식: `06.04`'); return; }
    let text;
    if (isLegacyDate(date)) {
      const member = getLegacyMember(date) || '—';
      text = `📅 *${dateLabel(date)}* 당번: *${member}* 님`;
    } else {
      const pintMain = getPintMain(date) || '—';
      const stickMain = getStickMain(date) || '—';
      const pintCheck = getPintCheck(date);
      const stickCheck = getStickCheck(date);
      const pintLine = pintCheck ? `${pintMain} (${pintCheck})` : pintMain;
      const stickLine = stickCheck ? `${stickMain} (${stickCheck})` : stickMain;
      text = `📅 *${dateLabel(date)}*\n\n📍 파인트: ${pintLine}\n📍 스틱바: ${stickLine}`;
    }
    await reply(text); return;
  }

  // 변경
  if (cmd === '변경') {
    if (parts.length !== 4) { await reply('❌ 사용법:\n• `@당번봇 변경 06.04 파인트 박지연`\n• `@당번봇 변경 06.04 파인트 박지연(이석영)`'); return; }
    const [, rawDate, loop, nameInput] = parts;
    const date = parseDate(rawDate);
    if (!date) { await reply('❌ 날짜 형식: `06.04`'); return; }
    const loopKeyMap = { '파인트': 'pint', '스틱바': 'stick' };
    const key = loopKeyMap[loop];
    if (!key) { await reply('❌ 루프는 `파인트` 또는 `스틱바`로 입력해주세요.'); return; }
    const combinedMatch = nameInput.match(/^(.+?)\((.+?)\)$/);
    if (combinedMatch) {
      const [, mainName, checkName] = combinedMatch;
      const checkKeyMap = { 'pint': 'pintCheck', 'stick': 'stickCheck' };
      overrides[`${date}:${key}`] = mainName;
      overrides[`${date}:${checkKeyMap[key]}`] = checkName;
      await updateWeeklyThread();
      await reply(`✅ *${dateLabel(date)} ${loop}* 당번 *${mainName}* 님, 크첵 *${checkName}* 님으로 변경했어요.`);
      return;
    }
    overrides[`${date}:${key}`] = nameInput;
    const checkKeyMap2 = { 'pint': 'pintCheck', 'stick': 'stickCheck' };
    if (checkKeyMap2[key]) overrides[`${date}:${checkKeyMap2[key]}`] = 'NONE';
    await updateWeeklyThread();
    await reply(`✅ *${dateLabel(date)} ${loop}* 을 *${nameInput}* 님으로 변경했어요.`);
    return;
  }

  // 취소
  if (cmd === '취소') {
    const rawDate = parts[1];
    const loop = parts[2] || null;
    const date = parseDate(rawDate);
    if (!date) { await reply('❌ 날짜 형식: `06.04`'); return; }
    const loopKeyMap = { '파인트': 'pint', '스틱바': 'stick' };
    if (loop) {
      const key = loopKeyMap[loop];
      if (!key) { await reply('❌ 루프는 `파인트` 또는 `스틱바`로 입력해주세요.'); return; }
      const overrideKey = `${date}:${key}`;
      if (overrides[overrideKey]) { delete overrides[overrideKey]; await reply(`↩️ *${dateLabel(date)} ${loop}* 변경을 취소했어요.`); }
      else await reply(`ℹ️ 변경된 내용이 없어요.`);
      return;
    }
    const removed = [];
    [`${date}:pint`, `${date}:stick`, `${date}:pintCheck`, `${date}:stickCheck`].forEach(k => {
      if (overrides[k]) { delete overrides[k]; removed.push(k); }
    });
    if (removed.length > 0) { await updateWeeklyThread(); await reply(`↩️ *${dateLabel(date)}* 전체 변경을 취소했어요.`); }
    else await reply(`ℹ️ 변경된 내용이 없어요.`);
    return;
  }

  // 요청
  if (cmd === '요청') {
    const rawDate = parts[1];
    const loop = parts[2] || null;
    const date = parseDate(rawDate);
    if (!date) { await reply('❌ 사용법: `@당번봇 요청 06.04 파인트`'); return; }
    if (loop && loop !== '파인트' && loop !== '스틱바') { await reply('❌ 루프는 `파인트` 또는 `스틱바`로 입력해주세요.'); return; }
    const loopText = loop ? ` ${loop}` : '';
    const requester = event.user;
    const requesterName = await getRealName(client, requester);
    const label = dateLabel(date);
    const actionValue = JSON.stringify({ date, loop: loop || null, requester: requesterName });
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: `🙏 당번 교체 요청`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `🙏 *당번 교체 요청*\n\n*${label}${loopText}* 당번을 대신 해주실 분 있으신가요?\n요청자: *${requesterName}* 님` } },
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: '✅ 수락' }, style: 'primary', action_id: 'duty_accept', value: actionValue },
          { type: 'button', text: { type: 'plain_text', text: '❌ 거절' }, style: 'danger', action_id: 'duty_decline', value: actionValue },
        ]},
      ],
    });
    return;
  }

  await reply(`❓ 모르는 명령어예요. \`@당번봇 매뉴얼\` 로 사용법을 확인해주세요!`);
});

// ─── 서버 시작 ────────────────────────────────────────
(async () => {
  await app.start(process.env.PORT || 3000);
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id;
  console.log('⚡ 당번 봇이 실행 중입니다! Bot ID:', botUserId);
})();
