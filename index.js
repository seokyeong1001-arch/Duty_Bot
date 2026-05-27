const { App } = require('@slack/bolt');
const cron = require('node-cron');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// ─── 설정 (여기만 수정) ───────────────────────────────
const CONFIG = {
  startDate: '2026-06-01', // 가영/선정이 첫날 당번
  notifyChannel: process.env.SLACK_CHANNEL,
  notifyTime: '30 7 * * *',
  weeklyTime: '30 7 * * 1',
  eveningNotifyTime: '0 18 * * *',

  // 파인트 루프: 가영 ↔ 지연 하루씩 교대
  pint: ['고가영', '지연'],
  // 스틱바 루프: 선정 ↔ 유진 하루씩 교대
  stick: ['문선정', '유진'],

  // 크첵 패턴 (지연/유진 당번날에만 붙음)
  // 파인트 크첵: 석영 → 가영 → 석영 → 가영 ...
  pintCheck: ['이석영', '고가영'],
  // 스틱바 크첵: 선정 → 석영 → 선정 → 석영 ...
  stickCheck: ['문선정', '이석영'],

  memberIds: {
    '고가영': 'U0A4DMQ1D99',
    '지연': 'U0AMT81HV42',
    '문선정': 'U07N2D1DYE6',
    '유진': 'U0AMPR3Q09K',
    '이석영': 'U06TTAA85TQ',
  },
};
// ─────────────────────────────────────────────────────

const overrides = {}; // { 'YYYY-MM-DD:pint': '이름', 'YYYY-MM-DD:stick': '이름' }
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
    return `${mainText} + ${checkText} (크첵)`;
  }
  return mainText;
}

function dutyMessage(dateStr, withTag = false) {
  const label = dateLabel(dateStr);
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
    const pintMain = getPintMain(ds) || '—';
    const stickMain = getStickMain(ds) || '—';
    const pintCheck = getPintCheck(ds);
    const stickCheck = getStickCheck(ds);
    const pintLine = pintCheck ? `${pintMain} + ${pintCheck}(크첵)` : pintMain;
    const stickLine = stickCheck ? `${stickMain} + ${stickCheck}(크첵)` : stickMain;
    lines.push(`• ${mm}/${dd} (${day})  파인트: ${pintLine}  |  스틱바: ${stickLine}`);
  }
  return lines.join('\n');
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
// 당번: /당번변경 06.02 파인트 지연
// 크첵: /당번변경 06.02 파인트크첵 가영
app.command('/당번변경', async ({ command, ack, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);
  if (parts.length !== 3) {
    await respond({ text: '❌ 사용법:\n• 당번: `/당번변경 06.02 파인트 지연`\n• 크첵: `/당번변경 06.02 파인트크첵 가영`', response_type: 'ephemeral' }); return;
  }
  const [rawDate, loop, name] = parts;
  const date = parseDate(rawDate);
  if (!date) { await respond({ text: '❌ 날짜 형식: `06.02`', response_type: 'ephemeral' }); return; }

  const loopKeyMap = { '파인트': 'pint', '스틱바': 'stick', '파인트크첵': 'pintCheck', '스틱바크첵': 'stickCheck' };
  const key = loopKeyMap[loop];
  if (!key) {
    await respond({ text: '❌ 루프는 `파인트` `스틱바` `파인트크첵` `스틱바크첵` 중 하나로 입력해주세요.', response_type: 'ephemeral' }); return;
  }
  overrides[`${date}:${key}`] = name;
  await respond({ text: `✅ *${dateLabel(date)} ${loop}* 을 *${name}* 님으로 변경했어요.`, response_type: 'in_channel' });
});

// ─── /당번취소 ────────────────────────────────────────
app.command('/당번취소', async ({ command, ack, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);
  const rawDate = parts[0];
  const loop = parts[1] || null;
  const date = parseDate(rawDate);
  if (!date) { await respond({ text: '❌ 날짜 형식: `06.02`', response_type: 'ephemeral' }); return; }

  const loopKeyMap = { '파인트': 'pint', '스틱바': 'stick', '파인트크첵': 'pintCheck', '스틱바크첵': 'stickCheck' };

  if (loop) {
    const key = loopKeyMap[loop];
    if (!key) {
      await respond({ text: '❌ 루프는 `파인트` `스틱바` `파인트크첵` `스틱바크첵` 중 하나로 입력해주세요.', response_type: 'ephemeral' }); return;
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
  if (removed.length > 0) await respond({ text: `↩️ *${dateLabel(date)}* 전체 변경을 취소했어요.`, response_type: 'in_channel' });
  else await respond({ text: `ℹ️ 변경된 내용이 없어요.`, response_type: 'ephemeral' });
});

// ─── /당번주간 ────────────────────────────────────────
app.command('/당번주간', async ({ ack, respond }) => {
  await ack();
  const today = todayStr();
  const label = getWeekLabel(today);
  await respond({ text: `📅 *${label} 당번 일정*\n${weeklyMessage(today)}`, response_type: 'ephemeral' });
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

// ─── 서버 시작 ────────────────────────────────────────
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡ 당번 봇이 실행 중입니다!');
})();
