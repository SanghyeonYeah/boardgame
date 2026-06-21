import { Net } from '/js/net.js';
import { renderLobby, toast, logLine, shareCode } from '/js/ui.js';
import {
  createInitialState, applyAction as engineApply, makePublic,
  ROLE, ROLE_KO, ROLE_DESC, isRenewTeam,
} from './engine.js';

const net = new Net('mafia');
let G = null;                 // 호스트 전용 전체 상태
let myRole = null;
let myNightTarget = null;
let privLog = [];
let lastLogLen = 0;
const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), waitRoom = $('waitRoom'), game = $('game');

// ---------- 호스트 전용 액션 처리 ----------
function hostApply(_publicState, action, fromId) {
  const act = action.playerId ? action : { ...action, playerId: fromId };
  engineApply(G, act);
  const pub = makePublic(G);
  flushPrivate();
  return pub;
}
function flushPrivate() {
  const aiIds = new Set(G.players.filter((p) => p.isAI).map((p) => p.id));
  for (const msg of G._private) {
    if (aiIds.has(msg.to)) continue; // AI 개인 메시지는 무시
    if (msg.to === net.id) handlePrivate(msg);
    else net.message({ kind: 'priv', to: msg.to, text: msg.text, tag: msg.tag, data: msg.data });
  }
  G._private = [];
}

// ---- AI 컨트롤러 (호스트 전용) ----
const AI_NAMES = ['태양봇', '에너지AI', '가이아봇', '녹색AI', '재생봇', '핵봇', '탄소봇', '클린봇', '스마트AI', '환경봇', '파워봇', '생태AI'];
let aiTimers = [];
let scheduledAiKey = '';

function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clearAiTimers() { aiTimers.forEach(clearTimeout); aiTimers = []; }

function addAI() {
  if (!net.isHost || !G || G.phase !== 'lobby') return;
  if (G.players.length >= 12) return toast('최대 12명입니다.');
  const used = new Set(G.players.filter((p) => p.isAI).map((p) => p.name));
  const name = AI_NAMES.find((n) => !used.has(n)) || `AI봇${G.players.filter((p) => p.isAI).length + 1}`;
  const aiId = 'ai_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  net.dispatch({ type: 'ADD_AI', playerId: net.id, aiId, aiName: name });
}

function removeAI(aiId) {
  if (!net.isHost || !G || G.phase !== 'lobby') return;
  net.dispatch({ type: 'REMOVE_AI', playerId: net.id, aiId });
}

function scheduleAI() {
  if (!net.isHost || !G) return;
  const key = `${G.phase}:${G.round}`;
  if (key === scheduledAiKey) return;
  scheduledAiKey = key;
  clearAiTimers();

  const aiAlive = G.players.filter((p) => p.isAI && p.alive);
  if (!aiAlive.length) return;

  if (G.phase === 'night') {
    aiAlive.forEach((ai, i) => {
      if (![ROLE.FOSSIL, ROLE.DOCTOR, ROLE.HACKER, ROLE.SPY].includes(G.roles[ai.id])) return;
      aiTimers.push(setTimeout(() => {
        if (!G.players.find((p) => p.id === ai.id && p.alive)) return;
        if (G.night.submitted.includes(ai.id)) return;
        const target = pickNightTarget(ai);
        if (target) net.dispatch({ type: 'NIGHT_ACTION', playerId: ai.id, target });
      }, 3000 + i * 1000 + Math.random() * 4000));
    });
  } else if (G.phase === 'day') {
    aiAlive.forEach((ai, idx) => {
      genAiChat(ai).forEach((text, i) => {
        aiTimers.push(setTimeout(() => {
          if (!G.players.find((p) => p.id === ai.id && p.alive)) return;
          net.dispatch({ type: 'CHAT', playerId: ai.id, text });
        }, 2000 + idx * 3000 + i * 5000 + Math.random() * 3000));
      });
      aiTimers.push(setTimeout(() => {
        if (!G.players.find((p) => p.id === ai.id && p.alive)) return;
        if (ai.id in G.votes) return;
        net.dispatch({ type: 'VOTE', playerId: ai.id, target: pickVote(ai) });
      }, 25000 + idx * 2000 + Math.random() * 25000));
    });
  }
}

function pickNightTarget(ai) {
  const role = G.roles[ai.id];
  const alive = G.players.filter((p) => p.alive);
  const others = alive.filter((p) => p.id !== ai.id);
  if (!others.length) return null;
  switch (role) {
    case ROLE.FOSSIL: { const safe = others.filter((p) => G.roles[p.id] !== ROLE.FOSSIL); return rnd(safe.length ? safe : others).id; }
    case ROLE.DOCTOR: return rnd(alive).id;
    case ROLE.HACKER: return rnd(others).id;
    case ROLE.SPY: return [...others].sort((a, b) => b.energy - a.energy)[0].id;
    default: return null;
  }
}

function genAiChat(ai) {
  const role = G.roles[ai.id];
  const others = G.players.filter((p) => p.alive && p.id !== ai.id);
  if (!others.length) return [];
  const isFossil = role === ROLE.FOSSIL;
  const suspect = () => { const pool = isFossil ? others.filter((p) => G.roles[p.id] !== ROLE.FOSSIL) : others; return rnd(pool.length ? pool : others).name; };

  const pool = [
    () => `${suspect()}이(가) 좀 수상한 것 같습니다. 다들 어떻게 생각하세요?`,
    () => `저는 화석연료가 아닙니다. 잘 생각해보세요.`,
    () => `가이아를 지킵시다! 화석연료를 반드시 찾아야 해요.`,
    () => `이번 투표는 신중하게 해야 할 것 같아요.`,
    () => `${rnd(others).name}님, 당신은 어떻게 생각하세요?`,
    () => `솔직히 아직 확신이 없어요. 더 토론해봐야 할 것 같습니다.`,
    () => `발언을 전혀 안 하는 분들이 더 수상합니다.`,
    () => `${suspect()}한테 투표할까 생각 중입니다.`,
    ...(isFossil
      ? [() => `저한테 투표하면 좋은 정보를 잃게 됩니다.`, () => `${suspect()}이(가) 어제부터 이상하게 행동하던데요.`]
      : [() => `밤에 죽은 분의 역할을 보면 화석연료의 전략이 보입니다.`, () => `화석연료는 지금 조용히 숨어있을 거예요.`]),
  ];

  const count = 1 + Math.floor(Math.random() * 3);
  const msgs = []; const used = new Set();
  for (let i = 0; i < count; i++) {
    let fn; let t = 0;
    do { fn = rnd(pool); t++; } while (used.has(fn) && t < 15);
    used.add(fn); msgs.push(fn());
  }
  return msgs;
}

function pickVote(ai) {
  const role = G.roles[ai.id];
  const alive = G.players.filter((p) => p.alive);
  const others = alive.filter((p) => p.id !== ai.id);
  if (!others.length) return 'skip';
  if (role === ROLE.FOSSIL) { const safe = others.filter((p) => G.roles[p.id] !== ROLE.FOSSIL); return rnd(safe.length ? safe : others).id; }
  const tally = {};
  Object.values(G.votes).forEach((t) => { if (t && t !== 'skip') tally[t] = (tally[t] || 0) + 1; });
  const top = Object.entries(tally).sort(([, a], [, b]) => b - a)[0];
  if (top && Math.random() > 0.35 && alive.find((p) => p.id === top[0])) return top[0];
  return rnd(others).id;
}

// ---------- 로비 ----------
function showLobby() {
  renderLobby({
    mount: lobby,
    subtitle: '에너지 변형 마피아는 8–12인 게임입니다. 방을 만들고 코드를 공유하세요.',
    onCreate: async ({ name }) => {
      G = createInitialState(net.id, name);
      engineApply(G, { type: 'JOIN', playerId: net.id, name });
      await net.createRoom(makePublic(G), hostApply, name);
      net.pushState(makePublic(G));
      flushPrivate();
      lobby.classList.add('hidden');
    },
    onJoin: async ({ code, name }) => {
      await net.joinRoom(code, name);
      net.dispatch({ type: 'JOIN', playerId: net.id, name });
      lobby.classList.add('hidden');
    },
  });
  const room = new URLSearchParams(location.search).get('room');
  if (room) { const i = lobby.querySelector('#lobbyCode'); if (i) i.value = room.toUpperCase(); }
}

net.onState = (s) => render(s);
net.onMessage = (payload) => {
  if (payload && payload.kind === 'priv' && payload.to === net.id) handlePrivate(payload);
};

function handlePrivate(msg) {
  if (msg.tag === 'role' && msg.data?.role) { myRole = msg.data.role; }
  privLog.push(msg);
  if (privLog.length > 100) privLog.shift();
  renderPriv();
  renderRoleCard();
}

// ---------- 렌더 ----------
function render(s) {
  if (!s) return;
  // 방 참가 이후엔 설명서 아코디언 닫기
  document.querySelectorAll('.manual').forEach((d) => { d.removeAttribute('open'); d.classList.add('hidden'); });
  if (s.phase === 'lobby') { renderWait(s); return; }
  waitRoom.classList.add('hidden'); lobby.classList.add('hidden');
  game.classList.remove('hidden');

  renderRoleCard();
  renderHeader(s);
  renderPlayers(s);
  renderChat(s);
  renderDmSelect(s);
  renderHostControls(s);
  renderOver(s);
  flushLog(s);
}

function me(s) { return s.players.find((p) => p.id === net.id); }

function renderWait(s) {
  waitRoom.classList.remove('hidden');
  game.classList.add('hidden');
  $('wCode').textContent = net.code;
  $('wCopy').onclick = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(net.code)
        .then(() => toast(`방 코드 복사됨: ${net.code}`))
        .catch(() => toast(`방 코드: ${net.code}`));
    } else { toast(`방 코드: ${net.code}`); }
  };
  $('wCount').textContent = s.players.length;
  const box = $('wPlayers');
  box.innerHTML = '';
  s.players.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'pm';
    d.innerHTML = `<span class="nm">${p.isAI ? '🤖 ' : ''}${p.name}${p.id === net.id ? ' (나)' : ''}</span>${p.id === s.hostId ? '<span class="role">방장</span>' : ''}${p.isAI ? '<span class="role">AI</span>' : ''}`;
    if (p.isAI && net.isHost) {
      const rm = document.createElement('button');
      rm.className = 'sm ghost'; rm.style.marginLeft = 'auto'; rm.textContent = '제거';
      rm.onclick = () => removeAI(p.id);
      d.appendChild(rm);
    }
    box.appendChild(d);
  });
  const start = $('wStart');
  if (net.isHost) {
    start.classList.remove('hidden');
    start.disabled = s.players.length < 8;
    start.onclick = () => net.dispatch({ type: 'START', playerId: net.id });
    $('wHint').textContent = s.players.length < 8 ? `8명 이상 필요 (현재 ${s.players.length})` : '시작 준비 완료!';
    const addBtn = $('wAddAI');
    if (addBtn) { addBtn.classList.remove('hidden'); addBtn.disabled = s.players.length >= 12; addBtn.onclick = addAI; }
  } else {
    start.classList.add('hidden');
    const addBtn = $('wAddAI');
    if (addBtn) addBtn.classList.add('hidden');
    $('wHint').textContent = '방장이 시작하기를 기다리는 중…';
  }
}

function renderRoleCard() {
  const card = $('roleCard');
  if (!myRole) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('roleName').textContent = '나의 역할: ' + ROLE_KO[myRole];
  $('roleDesc').textContent = ROLE_DESC[myRole];
}

function renderHeader(s) {
  const pill = $('phasePill');
  pill.textContent = s.phase === 'night' ? '🌙 밤' : s.phase === 'day' ? '☀️ 낮' : '게임 종료';
  pill.className = 'pill ' + (s.phase === 'night' ? 'night' : s.phase === 'day' ? 'day' : '');
  $('roundN').textContent = s.round;
  const full = Math.floor(s.gaiaHP);
  const half = s.gaiaHP - full >= 0.5;
  $('hp').textContent = '❤️'.repeat(full) + (half ? '💛' : '') + '🤍'.repeat(Math.max(0, 3 - full - (half ? 1 : 0))) + `  ${s.gaiaHP}/3`;
  $('alivePill').textContent = `생존 ${s.counts.alive}명`;
}

function renderPlayers(s) {
  const meP = me(s);
  const amAlive = meP && meP.alive;
  const box = $('gPlayers');
  box.innerHTML = '';

  // 헤더 안내
  let title = '플레이어', hint = '';
  if (s.phase === 'night') {
    if (amAlive && [ROLE.FOSSIL, ROLE.DOCTOR, ROLE.HACKER, ROLE.SPY].includes(myRole)) {
      title = '🌙 밤 — 능력 사용';
      hint = ({
        fossil: '제거할 대상을 지목하세요. (2에너지)',
        doctor: '보호할 대상을 지목하세요. (2에너지)',
        hacker: '감청할 대상을 지목하세요. (2에너지)',
        spy: '에너지를 훔칠 대상을 지목하세요.',
      })[myRole] + `  ·  행동 완료 ${s.nightProgress.done}/${s.nightProgress.total}`;
    } else {
      title = '🌙 밤'; hint = amAlive ? '특수 행동이 없습니다. 결과를 기다리세요.' : '당신은 탈락했습니다(관전).';
    }
  } else if (s.phase === 'day') {
    title = '☀️ 낮 — 투표';
    hint = amAlive ? '추방할 사람에게 투표하세요.' : '당신은 탈락했습니다(관전).';
  }
  $('actionTitle').textContent = title;
  $('actionHint').textContent = hint;

  // 투표 집계
  const tally = {};
  if (s.phase === 'day') Object.values(s.votes).forEach((t) => { if (t && t !== 'skip') tally[t] = (tally[t] || 0) + 1; });
  const myVote = s.votes[net.id];

  s.players.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'pm' + (p.alive ? '' : ' dead');
    if (s.phase === 'day' && myVote === p.id) d.classList.add('voted');
    const roleLabel = !p.alive && p.revealedRole ? `<span class="role">${ROLE_KO[p.revealedRole]}</span>`
      : (s.phase === 'over' && s.rolesReveal) ? `<span class="role">${ROLE_KO[s.rolesReveal[p.id]]}</span>` : '';
    d.innerHTML = `<span class="nm">${p.isAI ? '🤖 ' : ''}${p.name}${p.id === net.id ? ' (나)' : ''}</span>
      <span class="en">⚡${p.energy}</span> ${roleLabel}
      ${s.phase === 'day' && tally[p.id] ? `<span class="vote-tally">🗳️${tally[p.id]}</span>` : ''}`;

    const act = document.createElement('span');
    act.className = 'act';
    // 밤 능력 대상 선택
    if (s.phase === 'night' && amAlive && p.alive && [ROLE.FOSSIL, ROLE.DOCTOR, ROLE.HACKER, ROLE.SPY].includes(myRole)) {
      const selfOk = myRole === ROLE.DOCTOR; // 의사는 자기 보호 허용
      if (p.id !== net.id || selfOk) {
        const b = document.createElement('button'); b.className = 'sm';
        b.textContent = myNightTarget === p.id ? '지목됨 ✓' : '지목';
        if (myNightTarget === p.id) b.classList.add('primary');
        b.onclick = () => { myNightTarget = p.id; net.dispatch({ type: 'NIGHT_ACTION', playerId: net.id, target: p.id }); };
        act.appendChild(b);
      }
    }
    // 낮 투표
    if (s.phase === 'day' && amAlive && p.alive) {
      const b = document.createElement('button'); b.className = 'sm';
      b.textContent = myVote === p.id ? '투표함 ✓' : '투표';
      if (myVote === p.id) b.classList.add('primary');
      b.onclick = () => net.dispatch({ type: 'VOTE', playerId: net.id, target: p.id });
      act.appendChild(b);
    }
    d.appendChild(act);
    box.appendChild(d);
  });

  // 낮: 기권 버튼
  if (s.phase === 'day' && amAlive) {
    const skip = document.createElement('button');
    skip.className = 'sm ghost'; skip.style.marginTop = '6px';
    skip.textContent = s.votes[net.id] === 'skip' ? '기권함 ✓' : '기권';
    skip.onclick = () => net.dispatch({ type: 'VOTE', playerId: net.id, target: 'skip' });
    box.appendChild(skip);
  }
}

function renderHostControls(s) {
  const box = $('hostControls');
  box.innerHTML = '';
  if (!net.isHost) return;
  if (s.phase === 'night') {
    const b = document.createElement('button'); b.className = 'danger sm';
    b.textContent = '🌙 밤 강제 종료(해결)';
    b.onclick = () => net.dispatch({ type: 'RESOLVE_NIGHT', playerId: net.id });
    box.appendChild(b);
  } else if (s.phase === 'day') {
    const b = document.createElement('button'); b.className = 'accent sm';
    b.textContent = '🗳️ 투표 종료(개표)';
    b.onclick = () => net.dispatch({ type: 'RESOLVE_DAY', playerId: net.id });
    box.appendChild(b);
  }
  const note = document.createElement('span');
  note.className = 'muted small';
  note.textContent = ' 방장은 모두가 행동/투표를 마치지 않아도 강제로 진행할 수 있습니다.';
  box.appendChild(note);
}

function renderChat(s) {
  const box = $('chat');
  box.innerHTML = '';
  s.publicChat.forEach((c) => {
    const d = document.createElement('div'); d.className = 'c';
    d.innerHTML = `<b>${c.name}</b> <span class="muted small">[${c.round}R/${c.phase === 'night' ? '밤' : '낮'}]</span>: ${escapeHtml(c.text)}`;
    box.appendChild(d);
  });
  box.scrollTop = box.scrollHeight;

  const meP = me(s);
  const canTalk = meP && meP.alive;
  $('chatInput').disabled = !canTalk;
  $('chatSend').disabled = !canTalk;
  $('chatSend').onclick = sendChat;
  $('chatInput').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
  function sendChat() {
    const t = $('chatInput').value.trim();
    if (!t) return;
    net.dispatch({ type: 'CHAT', playerId: net.id, text: t });
    $('chatInput').value = '';
  }
}

function renderDmSelect(s) {
  const sel = $('dmTo');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— 귓속말 대상 —</option>';
  s.players.filter((p) => p.id !== net.id && !p.isAI).forEach((p) => {
    const o = document.createElement('option'); o.value = p.id; o.textContent = p.name + (p.alive ? '' : ' (탈락)');
    sel.appendChild(o);
  });
  if (cur) sel.value = cur;
  const meP = me(s);
  const canTalk = meP && meP.alive;
  $('dmInput').disabled = !canTalk; $('dmSend').disabled = !canTalk;
  $('dmSend').onclick = () => {
    const to = sel.value, t = $('dmInput').value.trim();
    if (!to) return toast('귓속말 대상을 선택하세요.');
    if (!t) return;
    net.dispatch({ type: 'DM', playerId: net.id, to, text: t });
    $('dmInput').value = '';
  };
}

function renderPriv() {
  const box = $('priv');
  if (!box) return;
  box.innerHTML = '';
  privLog.forEach((m) => {
    const d = document.createElement('div');
    d.className = 'pm2 tag-' + (m.tag || 'info');
    d.textContent = m.text;
    box.appendChild(d);
  });
  box.scrollTop = box.scrollHeight;
}

function renderOver(s) {
  const box = $('overBox');
  if (s.phase !== 'over') { box.innerHTML = ''; return; }
  const teamKo = { renewable: '🌳 재생에너지 진영', fossil: '🛢️ 화석연료 진영', spy: '🕵️ 산업 스파이' };
  const sorted = [...s.players].sort((a, b) => b.energy - a.energy);
  const rows = sorted.map((p, i) => {
    const role = (s.rolesReveal && s.rolesReveal[p.id]) || (p.revealedRole) || null;
    const roleStr = role ? ROLE_KO[role] : '?';
    return `<tr class="${i === 0 ? 'rank1' : ''}${p.alive ? '' : ' dead'}">
      <td>${i + 1}</td>
      <td>${escapeHtml(p.name)}${p.id === net.id ? ' <b>(나)</b>' : ''}</td>
      <td>${roleStr}</td>
      <td>⚡ ${p.energy}</td>
      <td>${p.alive ? '생존' : '탈락'}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="panel" style="margin-top:16px">
    <h2 style="text-align:center">${teamKo[s.winnerTeam] || '게임 종료'} 승리!</h2>
    <table class="result-table">
      <thead><tr><th>순위</th><th>이름</th><th>역할</th><th>에너지</th><th>상태</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="text-align:center"><button class="primary" onclick="location.reload()">새 게임</button></div>
  </div>`;
}

function flushLog(s) {
  const el = $('log'); if (!el) return;
  if (s.log.length < lastLogLen) lastLogLen = 0;
  for (let i = lastLogLen; i < s.log.length; i++) logLine(el, s.log[i]);
  lastLogLen = s.log.length;
}

function escapeHtml(t) { return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// 밤/라운드 전환 시 내 지목 초기화 + AI 스케줄
let prevKey = '';
const origOnState = net.onState;
net.onState = (s) => {
  const key = s ? `${s.phase}:${s.round}` : '';
  if (key !== prevKey) { myNightTarget = null; prevKey = key; }
  origOnState(s);
  if (s && s.phase !== 'lobby' && s.phase !== 'over') scheduleAI();
};

function setupEmojiBar(barId, inputId) {
  const bar = $(barId);
  if (!bar) return;
  const EMOJIS = ['🌱','🛢️','⚡','🔥','💡','🌍','🤝','👀','🕵️','❓','✅','❌','💰','🌙','☀️','😊','😈','🤫','🙏','👆','🤔','🫡','🧐','😱','🤐'];
  EMOJIS.forEach((e) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'emoji-btn'; btn.textContent = e;
    btn.onclick = () => {
      const inp = $(inputId);
      const s = inp.selectionStart ?? inp.value.length;
      const en = inp.selectionEnd ?? s;
      inp.value = inp.value.slice(0, s) + e + inp.value.slice(en);
      inp.setSelectionRange(s + e.length, s + e.length);
      inp.focus();
    };
    bar.appendChild(btn);
  });
}
setupEmojiBar('chatEmoji', 'chatInput');
setupEmojiBar('dmEmoji', 'dmInput');

showLobby();
