const { App } = require('@slack/bolt');
const cron = require('node-cron');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// ─── 설정 (여기만 수정) ───────────────────────────────
const CONFIG = {
  members: ['문선정', '고가영', '이석영'],
  startDate: '2026-01-01',
  notifyChannel: process.env.SLACK_CHANNEL,
  notifyTime: '30 7 * * *',
  weeklyTime: '30 7 * * 1',
};
// ─────────────────────────────────────────────────────

const overrides = {};

// "05.20" → "2026-05-20" 변환 (현재 연도 자동 적용)
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

function getDutyMember(dateStr) {
  if (overrides[dateStr]) return overrides[dateStr];
  const start = new Date(CONFIG.startDate);
  const target = new Date(dateStr);
  const diff = Math.round((target - start) / (1000 * 60 * 60 * 24));
  if (diff < 0) return null;
  return CONFIG.members[diff % CONFIG.members.length];
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

function dutyMessage(dateStr) {
  const amOv = overrides[`${dateStr}:오전`];
  const pmOv = overrides[`${dateStr}:오후`];
  const label = dateLabel(dateStr);

  if (amOv || pmOv) {
    const base = getDutyMember(dateStr);
    const am = amOv || base;
    const pm = pmOv || base;
    return `🔔 *[당번 알림]* ${label}\n\n오전: *${am}* 님  |  오후: *${pm}* 님\n수고해주세요 💪`;
  }

  const member = getDutyMember(dateStr);
  return member
    ? `🔔 *[당번 알림]* ${label}\n\n오늘 당번은 *${member}* 님입니다! 수고해주세요 💪`
    : `⚠️ 당번 정보를 불러올 수 없어요.`;
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
    const amOv = overrides[`${ds}:오전`];
    const pmOv = overrides[`${ds}:오후`];
    const base = overrides[ds] || getDutyMember(ds) || '—';
    let line;
    if (amOv || pmOv) {
      line = `• ${mm}/${dd} (${day})\n  오전: ${amOv ? `${amOv} _(변경)_` : base}  |  오후: ${pmOv ? `${pmOv} _(변경)_` : base}`;
    } else {
      line = `• ${mm}/${dd} (${day})  ${base}${overrides[ds] ? ' _(변경)_' : ''}`;
    }
    lines.push(line);
  }
  return `📅 *이번 주 당번 일정*\n${lines.join('\n')}`;
}

// ─── /당번취소 ────────────────────────────────────────
// 하루 전체: /당번취소 05.20
// 시간대 지정: /당번취소 05.20 오전
app.command('/당번취소', async ({ command, ack, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);
  const rawDate = parts[0];
  const slot = parts[1] || null;

  const date = parseDate(rawDate);
  if (!date) {
    await respond({ text: '❌ 날짜 형식: `05.20`', response_type: 'ephemeral' }); return;
  }
  if (slot && slot !== '오전' && slot !== '오후') {
    await respond({ text: '❌ 시간대는 `오전` 또는 `오후`로 입력해주세요.', response_type: 'ephemeral' }); return;
  }

  if (slot) {
    const key = `${date}:${slot}`;
    if (overrides[key]) {
      delete overrides[key];
      await respond({ text: `↩️ *${dateLabel(date)} ${slot}* 변경을 취소했어요.`, response_type: 'in_channel' });
    } else {
      await respond({ text: `ℹ️ *${dateLabel(date)} ${slot}*에 수동 변경된 당번이 없어요.`, response_type: 'ephemeral' });
    }
    return;
  }

  const removed = [];
  [date, `${date}:오전`, `${date}:오후`].forEach(k => { if (overrides[k]) { delete overrides[k]; removed.push(k); } });
  if (removed.length > 0) {
    await respond({ text: `↩️ *${dateLabel(date)}* 당번 변경을 취소했어요.`, response_type: 'in_channel' });
  } else {
    await respond({ text: `ℹ️ *${dateLabel(date)}*에 수동 변경된 당번이 없어요.`, response_type: 'ephemeral' });
  }
});

// ─── /당번변경 ────────────────────────────────────────
// 하루 전체: /당번변경 05.20 고가영
// 시간대 지정: /당번변경 05.20 오후 고가영
app.command('/당번변경', async ({ command, ack, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);

  if (parts.length === 3) {
    const [rawDate, slot, name] = parts;
    const date = parseDate(rawDate);
    if (!date) {
      await respond({ text: '❌ 날짜 형식: `05.20`', response_type: 'ephemeral' }); return;
    }
    if (slot !== '오전' && slot !== '오후') {
      await respond({ text: '❌ 시간대는 `오전` 또는 `오후`로 입력해주세요.', response_type: 'ephemeral' }); return;
    }
    overrides[`${date}:${slot}`] = name;
    await respond({ text: `✅ *${dateLabel(date)} ${slot}* 당번을 *${name}* 님으로 변경했어요.`, response_type: 'in_channel' });
    return;
  }

  if (parts.length === 2) {
    const [rawDate, name] = parts;
    const date = parseDate(rawDate);
    if (!date) {
      await respond({ text: '❌ 날짜 형식: `05.20`', response_type: 'ephemeral' }); return;
    }
    overrides[date] = name;
    await respond({ text: `✅ *${dateLabel(date)}* 당번을 *${name}* 님으로 변경했어요.`, response_type: 'in_channel' });
    return;
  }

  await respond({
    text: '❌ 사용법:\n• 하루 전체: `/당번변경 05.20 고가영`\n• 시간대 지정: `/당번변경 05.20 오후 고가영`',
    response_type: 'ephemeral',
  });
});

// ─── /당번주간 : 나에게만 보이는 이번 주 일정 ──────────
app.command("/당번주간", async ({ ack, respond }) => {
  await ack();
  await respond({ text: weeklyMessage(todayStr()), response_type: "ephemeral" });
});

// ─── /당번요청 ────────────────────────────────────────
// 하루 전체: /당번요청 05.20
// 시간대 지정: /당번요청 05.20 오후
app.command('/당번요청', async ({ command, ack, client, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);
  const rawDate = parts[0];
  const slot = parts[1] || null;

  const date = parseDate(rawDate);
  if (!date) {
    await respond({ text: '❌ 사용법:\n• 하루 전체: `/당번요청 05.20`\n• 시간대 지정: `/당번요청 05.20 오후`', response_type: 'ephemeral' }); return;
  }
  if (slot && slot !== '오전' && slot !== '오후') {
    await respond({ text: '❌ 시간대는 `오전` 또는 `오후`로 입력해주세요.', response_type: 'ephemeral' }); return;
  }

  const slotText = slot ? ` ${slot}` : '';
  const requester = await getRealName(client, command.user_id);
  const label = dateLabel(date);
  const actionValue = JSON.stringify({ date, slot: slot || null, requester });

  await client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    text: `🙏 당번 교체 요청`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🙏 *당번 교체 요청*\n\n*${label}${slotText}* 당번을 대신 해주실 분 있으신가요?\n요청자: *${requester}* 님`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ 수락' },
            style: 'primary',
            action_id: 'duty_accept',
            value: actionValue,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ 거절' },
            style: 'danger',
            action_id: 'duty_decline',
            value: actionValue,
          },
        ],
      },
    ],
  });

  await respond({ text: `📨 *${label}${slotText}* 교체 요청을 채널에 보냈어요.`, response_type: 'ephemeral' });
});

// ─── 수락 버튼 처리 ───────────────────────────────────
app.action('duty_accept', async ({ body, ack, client }) => {
  await ack();
  const { date, slot, requester } = JSON.parse(body.actions[0].value);
  const acceptor = await getRealName(app.client, body.user.id);
  const label = dateLabel(date);
  const slotText = slot ? ` ${slot}` : '';

  if (slot) {
    overrides[`${date}:${slot}`] = acceptor;
  } else {
    overrides[date] = acceptor;
  }

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `✅ 당번 교체 완료`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *당번 교체 완료*\n\n*${label}${slotText}* 당번이 *${acceptor}* 님으로 변경됐어요!\n${requester} 님 → *${acceptor}* 님 🎉`,
        },
      },
    ],
  });
});

// ─── 거절 버튼 처리 ───────────────────────────────────
app.action('duty_decline', async ({ body, ack, client }) => {
  await ack();
  const { date, slot, requester } = JSON.parse(body.actions[0].value);
  const decliner = await getRealName(app.client, body.user.id);
  const label = dateLabel(date);
  const slotText = slot ? ` ${slot}` : '';

  await client.chat.postMessage({
    channel: body.channel.id,
    thread_ts: body.message.ts,
    text: `*${decliner}* 님이 *${label}${slotText}* 교체 요청을 거절했어요.`,
  });
});

// ─── 매일 07:30 당번 알림 ────────────────────────────
cron.schedule(CONFIG.notifyTime, async () => {
  await app.client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    text: dutyMessage(todayStr()),
  });
}, { timezone: 'Asia/Seoul' });

// ─── 매주 월요일 07:30 주간 일정 ─────────────────────
cron.schedule(CONFIG.weeklyTime, async () => {
  await app.client.chat.postMessage({
    channel: CONFIG.notifyChannel,
    text: weeklyMessage(todayStr()),
  });
}, { timezone: 'Asia/Seoul' });

// ─── 서버 시작 ────────────────────────────────────────
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡ 당번 봇이 실행 중입니다!');
})();
