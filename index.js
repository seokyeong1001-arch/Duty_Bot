const { App } = require('@slack/bolt');
const cron = require('node-cron');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// ─── 설정 (여기만 수정) ───────────────────────────────
const CONFIG = {
  members: ['김민준', '이서윤', '박지호'], // 순환 순서
  startDate: '2025-05-17',                 // 첫 번째 멤버 당번 시작일 (오전 기준)
  notifyChannel: process.env.SLACK_CHANNEL,

  // 슬롯 정의: key는 내부 식별자, label은 표시 이름, cron은 알림 시각
  slots: [
    { key: 'am', label: '오전', cron: '30 7 * * *' },
    { key: 'pm', label: '오후', cron: '0 13 * * *' },
  ],
};
// ─────────────────────────────────────────────────────

// 시간대별 수동 변경 저장소
// { 'YYYY-MM-DD:am': '이름', 'YYYY-MM-DD:pm': '이름' }
const overrides = {};

// 슬롯 key 목록
const slotKeys = CONFIG.slots.map(s => s.key);

// 날짜+슬롯 기준으로 순환 인덱스 계산
function getDutyMember(dateStr, slotKey) {
  const overrideKey = `${dateStr}:${slotKey}`;
  if (overrides[overrideKey]) return overrides[overrideKey];

  const start = new Date(CONFIG.startDate);
  const target = new Date(dateStr);
  const dayDiff = Math.round((target - start) / (1000 * 60 * 60 * 24));
  if (dayDiff < 0) return null;

  const slotIdx = slotKeys.indexOf(slotKey);
  const totalSlotIdx = dayDiff * slotKeys.length + slotIdx;
  return CONFIG.members[totalSlotIdx % CONFIG.members.length];
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function currentSlotKey() {
  const hour = parseInt(
    new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }),
    10
  );
  return hour >= 13 ? 'pm' : 'am';
}

function slotLabel(slotKey) {
  return CONFIG.slots.find(s => s.key === slotKey)?.label || slotKey;
}

function dutyMessage(dateStr, slotKey) {
  const member = getDutyMember(dateStr, slotKey);
  const d = new Date(dateStr);
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const day = dayNames[d.getDay()];
  const [, mm, dd] = dateStr.split('-');
  const label = slotLabel(slotKey);
  return member
    ? `🔔 *[당번 알림]* ${mm}/${dd} (${day}) ${label}\n\n${label} 당번은 *${member}* 님입니다! 수고해주세요 💪`
    : `⚠️ 당번 정보를 불러올 수 없어요.`;
}

// ─── /당번 : 현재 시간대 당번 확인 ───────────────────
app.command('/당번', async ({ ack, respond }) => {
  await ack();
  const today = todayStr();
  const slot = currentSlotKey();
  await respond({ text: dutyMessage(today, slot), response_type: 'in_channel' });
});

// ─── /당번순서 : 전체 순환 순서 확인 ─────────────────
app.command('/당번순서', async ({ ack, respond }) => {
  await ack();
  const today = todayStr();
  const slot = currentSlotKey();
  const currentMember = getDutyMember(today, slot);
  const lines = CONFIG.members.map((m, i) => {
    const marker = m === currentMember ? ' ← 지금' : '';
    return `${i + 1}. ${m}${marker}`;
  });
  await respond({
    text: `📋 *당번 순환 순서*\n${lines.join('\n')}`,
    response_type: 'ephemeral',
  });
});

// ─── /당번변경 ────────────────────────────────────────
// 시간대 지정: /당번변경 2025-05-20 오후 이서윤
// 하루 전체:   /당번변경 2025-05-20 이서윤
app.command('/당번변경', async ({ command, ack, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);

  if (parts.length === 3) {
    const [date, slotLabelInput, name] = parts;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      await respond({ text: '❌ 날짜 형식: `YYYY-MM-DD`', response_type: 'ephemeral' });
      return;
    }
    const slot = CONFIG.slots.find(s => s.label === slotLabelInput);
    if (!slot) {
      const labels = CONFIG.slots.map(s => s.label).join('|');
      await respond({ text: `❌ 시간대는 \`${labels}\` 중 하나로 입력해주세요.`, response_type: 'ephemeral' });
      return;
    }
    overrides[`${date}:${slot.key}`] = name;
    await respond({
      text: `✅ *${date} ${slot.label}* 당번을 *${name}* 님으로 변경했어요.`,
      response_type: 'in_channel',
    });
    return;
  }

  if (parts.length === 2) {
    const [date, name] = parts;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      await respond({ text: '❌ 날짜 형식: `YYYY-MM-DD`', response_type: 'ephemeral' });
      return;
    }
    CONFIG.slots.forEach(s => { overrides[`${date}:${s.key}`] = name; });
    await respond({
      text: `✅ *${date}* 하루 전체 당번을 *${name}* 님으로 변경했어요.`,
      response_type: 'in_channel',
    });
    return;
  }

  await respond({
    text: '❌ 사용법:\n• 시간대 지정: `/당번변경 2025-05-20 오후 이서윤`\n• 하루 전체: `/당번변경 2025-05-20 이서윤`',
    response_type: 'ephemeral',
  });
});

// ─── /당번취소 ────────────────────────────────────────
// 시간대 지정: /당번취소 2025-05-20 오후
// 하루 전체:   /당번취소 2025-05-20
app.command('/당번취소', async ({ command, ack, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);
  const date = parts[0];

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    await respond({ text: '❌ 날짜 형식: `YYYY-MM-DD`', response_type: 'ephemeral' });
    return;
  }

  if (parts.length === 2) {
    const slot = CONFIG.slots.find(s => s.label === parts[1]);
    if (!slot) {
      const labels = CONFIG.slots.map(s => s.label).join('|');
      await respond({ text: `❌ 시간대는 \`${labels}\` 중 하나로 입력해주세요.`, response_type: 'ephemeral' });
      return;
    }
    const key = `${date}:${slot.key}`;
    if (overrides[key]) {
      delete overrides[key];
      await respond({ text: `↩️ *${date} ${slot.label}* 변경을 취소했어요.`, response_type: 'in_channel' });
    } else {
      await respond({ text: `ℹ️ *${date} ${slot.label}*에 수동 변경된 당번이 없어요.`, response_type: 'ephemeral' });
    }
    return;
  }

  const removed = CONFIG.slots.filter(s => {
    const key = `${date}:${s.key}`;
    if (overrides[key]) { delete overrides[key]; return true; }
    return false;
  });
  if (removed.length > 0) {
    await respond({ text: `↩️ *${date}* 전체 변경을 취소했어요.`, response_type: 'in_channel' });
  } else {
    await respond({ text: `ℹ️ *${date}*에 수동 변경된 당번이 없어요.`, response_type: 'ephemeral' });
  }
});

// ─── /당번주간 : 이번 주 당번 미리보기 ───────────────
app.command('/당번주간', async ({ ack, respond }) => {
  await ack();
  const today = todayStr();
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const lines = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const ds = d.toLocaleDateString('sv-SE');
    const [, mm, dd] = ds.split('-');
    const day = dayNames[d.getDay()];
    const isToday = ds === today ? ' *← 오늘*' : '';

    const slotParts = CONFIG.slots.map(s => {
      const member = getDutyMember(ds, s.key) || '—';
      const isOverride = overrides[`${ds}:${s.key}`] ? '_(변경)_' : '';
      return `${s.label}: ${member} ${isOverride}`.trim();
    });

    lines.push(`• ${mm}/${dd} (${day})${isToday}\n  ${slotParts.join('  |  ')}`);
  }

  await respond({
    text: `📅 *이번 주 당번 일정*\n${lines.join('\n')}`,
    response_type: 'ephemeral',
  });
});

// ─── 슬롯별 자동 알림 스케줄 ─────────────────────────
CONFIG.slots.forEach(slot => {
  cron.schedule(slot.cron, async () => {
    const today = todayStr();
    await app.client.chat.postMessage({
      channel: CONFIG.notifyChannel,
      text: dutyMessage(today, slot.key),
    });
  }, { timezone: 'Asia/Seoul' });
});

// ─── 서버 시작 ────────────────────────────────────────
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡ 당번 봇이 실행 중입니다!');
})();
