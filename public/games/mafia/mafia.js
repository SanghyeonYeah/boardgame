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
    if (aiIds.has(msg.to)) {
      // AI가 쪽지를 받으면 자동 답장 생성
      if (msg.tag === 'dm' && msg.data?.fromId) scheduleAiDmReply(msg.to, msg.data.fromId, msg.text);
      continue;
    }
    if (msg.to === net.id) handlePrivate(msg);
    else net.message({ kind: 'priv', to: msg.to, text: msg.text, tag: msg.tag, data: msg.data });
  }
  G._private = [];
}

// ---- AI 컨트롤러 (호스트 전용) ----
const AI_NAMES = ['태양봇', '에너지AI', '기후봇', '녹색AI', '재생봇', '핵봇', '탄소봇', '클린봇', '스마트AI', '환경봇', '파워봇', '생태AI'];
const GEMINI_MODEL = 'gemini-3.5-flash';
let aiTimers = [];
let scheduledAiKey = '';
let dayPhaseStart = 0;       // 낮 페이즈 시작 시각 (투표 락 기준)
let dayCountdownInterval = null; // 투표 카운트다운 인터벌
let lastState = null;        // 카운트다운 만료 시 re-render용 캐시

function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clearAiTimers() {
  aiTimers.forEach(clearTimeout); aiTimers = [];
  // dayCountdownInterval은 net.onState 오버라이드에서 관리
}

// ---------- Gemini API ----------
async function callGemini(prompt, maxTokens = 200) {
  const apiKey = window.__GEMINI_KEY__;
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1.0, maxOutputTokens: maxTokens },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch { return null; }
}

function aiContext(ai) {
  const role = G.roles[ai.id];
  const alive = G.players.filter((p) => p.alive);
  const others = alive.filter((p) => p.id !== ai.id);
  const fossils = G.players.filter((p) => G.roles[p.id] === ROLE.FOSSIL).map((p) => p.name);
  const recentChat = G.publicChat.filter((c) => c.round === G.round).slice(-15).map((c) => `${c.name}: ${c.text}`).join('\n') || '(이번 라운드 채팅 없음)';
  const recentLog = G.log.slice(-6).join('\n');
  return { role, alive, others, fossils, recentChat, recentLog };
}

function scheduleAiDmReply(aiId, fromId, msgText) {
  const ai = G.players.find((p) => p.id === aiId);
  if (!ai?.alive) return;
  const originalText = msgText.replace(/^\(익명→나\) /, '');
  setTimeout(async () => {
    if (!G.players.find((p) => p.id === aiId && p.alive)) return;
    const role = G.roles[aiId];
    const roleHint = role === ROLE.FOSSIL
      ? '당신은 화석연료(마피아)입니다. 정체를 숨기며 자연스럽게 답장하세요.'
      : role === ROLE.SPY ? '당신은 산업 스파이입니다. 중립적으로 답장하세요.'
      : `당신은 ${ROLE_KO[role]}입니다.`;
    const prompt = `당신은 "에너지 변형 마피아" AI 플레이어 "${ai.name}"입니다.
${roleHint}
익명의 쪽지를 받았습니다: "${originalText}"
한국어로 1~2문장으로 답장을 작성하세요. 메시지 텍스트만 출력하세요.`;
    const raw = await callGemini(prompt, 150);
    const reply = raw?.replace(/^["']|["']$/g, '').trim()
      || rnd(['...', '네, 알겠습니다.', '흠, 생각해볼게요.', '그렇군요.', '잠깐만요.']);
    if (G.players.find((p) => p.id === aiId && p.alive)) {
      net.dispatch({ type: 'DM', playerId: aiId, to: fromId, text: reply });
    }
  }, 2000 + Math.random() * 4000);
}

async function aiChatMsg(ai) {
  const { role, others, fossils, recentChat, recentLog } = aiContext(ai);
  if (!others.length) return null;

  const roleHint = role === ROLE.FOSSIL
    ? `당신은 화석연료(마피아)입니다. 정체를 숨기세요. 동료 화석연료: ${fossils.join(', ')}. 이들을 의심하거나 투표하지 마세요.`
    : role === ROLE.SPY
    ? '당신은 산업 스파이입니다. 독립 세력이므로 정체를 숨기고 중립적으로 행동하세요.'
    : `당신은 ${ROLE_KO[role]}입니다. 화석연료를 찾으려 노력하세요.`;

  const prompt = `당신은 "에너지 변형 마피아" 게임의 AI 플레이어 "${ai.name}"입니다.
${roleHint}
생존자: ${others.map((p) => p.name).join(', ')}
최근 게임 로그:\n${recentLog}
최근 채팅:\n${recentChat}

지금 낮 토론 시간입니다. 역할에 맞게 자연스러운 한국어 채팅 메시지를 딱 1문장으로 작성하세요.
메시지 텍스트만 출력하세요 (이름, 설명, 따옴표 없이).`;

  const text = await callGemini(prompt, 120);
  if (text) return text.replace(/^["']|["']$/g, '').trim();

  // 폴백: 템플릿
  const isFossil = role === ROLE.FOSSIL;
  const suspect = () => { const pool = isFossil ? others.filter((p) => G.roles[p.id] !== ROLE.FOSSIL) : others; return rnd(pool.length ? pool : others).name; };
  return rnd([
    `${suspect()}이(가) 좀 수상합니다.`,
    '저는 화석연료가 아닙니다.',
    `${rnd(others).name}님은 어떻게 생각하세요?`,
    '이번 투표 신중하게 해요.',
  ]);
}

async function aiNightDecision(ai) {
  const role = G.roles[ai.id];
  const alive = G.players.filter((p) => p.alive);
  const others = alive.filter((p) => p.id !== ai.id);
  if (!others.length) return null;

  const actionDesc = {
    [ROLE.FOSSIL]: `화석연료입니다. 오늘 밤 제거할 재생에너지 팀원을 1명 선택하세요. 동료 화석연료(${G.players.filter((p) => G.roles[p.id] === ROLE.FOSSIL && p.id !== ai.id).map((p) => p.name).join(', ') || '없음'})는 절대 선택하지 마세요.`,
    [ROLE.DOCTOR]: '태양광 패널(의사)입니다. 오늘 밤 공격에서 보호할 플레이어 1명을 선택하세요.',
    [ROLE.HACKER]: '원자력 에너지(해커)입니다. 오늘 밤 메시지를 감청할 플레이어 1명을 선택하세요.',
    [ROLE.SPY]: '산업 스파이입니다. 에너지를 훔칠 플레이어 1명을 선택하세요.',
  }[role];

  const candidates = role === ROLE.FOSSIL
    ? others.filter((p) => G.roles[p.id] !== ROLE.FOSSIL)
    : role === ROLE.DOCTOR ? alive : others;
  if (!candidates.length) return rnd(others)?.id || null;

  const list = candidates.map((p) => `${p.name} → id: ${p.id}`).join('\n');
  const prompt = `에너지 변형 마피아 AI 플레이어 "${ai.name}"입니다.
역할: ${actionDesc}
선택 가능한 플레이어 목록:
${list}

대상 플레이어의 id를 정확히 출력하세요. id 외에 다른 텍스트는 절대 출력하지 마세요.`;

  const resp = await callGemini(prompt, 60);
  if (resp) {
    const trimmed = resp.trim();
    if (candidates.find((p) => p.id === trimmed)) return trimmed;
  }
  // 폴백
  if (role === ROLE.SPY) return [...candidates].sort((a, b) => b.energy - a.energy)[0].id;
  return rnd(candidates).id;
}

async function aiVoteDecision(ai) {
  const role = G.roles[ai.id];
  const alive = G.players.filter((p) => p.alive);
  const others = alive.filter((p) => p.id !== ai.id);
  if (!others.length) return 'skip';

  const { fossils, recentChat, recentLog } = aiContext(ai);
  const roleHint = role === ROLE.FOSSIL
    ? `당신은 화석연료입니다. 동료(${fossils.join(', ')})를 보호하고, 재생에너지 팀원에게 투표하세요.`
    : `당신은 ${ROLE_KO[role]}입니다. 화석연료로 의심되는 사람에게 투표하세요.`;

  const tally = {};
  Object.values(G.votes).forEach((t) => { if (t && t !== 'skip') tally[t] = (tally[t] || 0) + 1; });
  const tallyStr = Object.entries(tally).map(([id, n]) => `${G.players.find((p) => p.id === id)?.name}: ${n}표`).join(', ') || '(아직 투표 없음)';

  const list = others.map((p) => `${p.name} → id: ${p.id}`).join('\n');
  const prompt = `에너지 변형 마피아 AI 플레이어 "${ai.name}"입니다.
${roleHint}
생존자 목록:
${list}
현재 투표 현황: ${tallyStr}
최근 채팅:\n${recentChat}
최근 로그:\n${recentLog}

투표할 플레이어의 id를 정확히 출력하세요. 기권하려면 skip을 출력하세요.
id 또는 skip 외에 다른 텍스트는 절대 출력하지 마세요.`;

  const resp = await callGemini(prompt, 60);
  if (resp) {
    const trimmed = resp.trim();
    if (trimmed === 'skip') return 'skip';
    if (others.find((p) => p.id === trimmed)) return trimmed;
  }
  // 폴백
  if (role === ROLE.FOSSIL) {
    const safe = others.filter((p) => G.roles[p.id] !== ROLE.FOSSIL);
    return rnd(safe.length ? safe : others).id;
  }
  const top = Object.entries(tally).sort(([, a], [, b]) => b - a)[0];
  if (top && alive.find((p) => p.id === top[0])) return top[0];
  return rnd(others).id;
}

// ---------- 스케줄러 ----------
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
      aiTimers.push(setTimeout(async () => {
        if (!G.players.find((p) => p.id === ai.id && p.alive)) return;
        if (G.night.submitted.includes(ai.id)) return;
        const target = await aiNightDecision(ai);
        if (target) net.dispatch({ type: 'NIGHT_ACTION', playerId: ai.id, target });
      }, 2000 + i * 800 + Math.random() * 3000));
    });
  } else if (G.phase === 'day') {
    const chatCount = 2 + Math.floor(Math.random() * 3); // AI당 2~4회 채팅
    aiAlive.forEach((ai, idx) => {
      for (let i = 0; i < chatCount; i++) {
        // 15초 이후부터 채팅 — 인간이 먼저 말하도록 여유 부여
        const delay = 15000 + idx * 6000 + i * 18000 + Math.random() * 7000;
        aiTimers.push(setTimeout(async () => {
          if (!G.players.find((p) => p.id === ai.id && p.alive)) return;
          const text = await aiChatMsg(ai);
          if (text) net.dispatch({ type: 'CHAT', playerId: ai.id, text });
        }, delay));
      }
      // 투표 락(30초) 이후에만 투표
      aiTimers.push(setTimeout(async () => {
        if (!G.players.find((p) => p.id === ai.id && p.alive)) return;
        if (ai.id in G.votes) return;
        const target = await aiVoteDecision(ai);
        net.dispatch({ type: 'VOTE', playerId: ai.id, target: target || 'skip' });
      }, 35000 + idx * 4000 + Math.random() * 40000));
    });
  }
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
  lastState = s;
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

  // 투표 락: 낮 시작 30초 동안 투표 불가
  const VOTE_LOCK_MS = 30000;
  const voteUnlocked = dayPhaseStart === 0 || (Date.now() - dayPhaseStart) >= VOTE_LOCK_MS;
  const voteRemaining = voteUnlocked ? 0 : Math.ceil((VOTE_LOCK_MS - (Date.now() - dayPhaseStart)) / 1000);

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
    hint = !amAlive ? '당신은 탈락했습니다(관전).'
      : voteUnlocked ? '추방할 사람에게 투표하세요.'
      : `⏳ ${voteRemaining}초 후 투표 가능 — 자유롭게 토론하세요.`;
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
      b.disabled = !voteUnlocked;
      b.onclick = () => { if (voteUnlocked) net.dispatch({ type: 'VOTE', playerId: net.id, target: p.id }); };
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
    skip.disabled = !voteUnlocked;
    skip.onclick = () => { if (voteUnlocked) net.dispatch({ type: 'VOTE', playerId: net.id, target: 'skip' }); };
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
  s.players.filter((p) => p.id !== net.id).forEach((p) => {
    const o = document.createElement('option'); o.value = p.id;
    o.textContent = (p.isAI ? '🤖 ' : '') + p.name + (p.alive ? '' : ' (탈락)');
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
    const toPlayer = s.players.find((p) => p.id === to);
    net.dispatch({ type: 'DM', playerId: net.id, to, text: t });
    if (toPlayer?.isAI) toast(`🤖 ${toPlayer.name}에게 쪽지 전송 — 잠시 후 답장 도착`);
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

// 밤/라운드 전환 시 내 지목 초기화 + 투표 락 + AI 스케줄
let prevKey = '';
const origOnState = net.onState;
net.onState = (s) => {
  const key = s ? `${s.phase}:${s.round}` : '';
  if (key !== prevKey) {
    myNightTarget = null;
    prevKey = key;
    // 낮 시작: 투표 락 타이머를 render(s) 보다 먼저 설정해야 버튼이 처음부터 잠김
    if (dayCountdownInterval) { clearInterval(dayCountdownInterval); dayCountdownInterval = null; }
    if (s?.phase === 'day') {
      dayPhaseStart = Date.now();
      dayCountdownInterval = setInterval(() => {
        const remaining = Math.ceil((30000 - (Date.now() - dayPhaseStart)) / 1000);
        if (remaining <= 0) {
          clearInterval(dayCountdownInterval); dayCountdownInterval = null;
          if (lastState) renderPlayers(lastState); // 투표 버튼 활성화
        } else {
          const hintEl = document.getElementById('actionHint');
          if (hintEl) hintEl.textContent = `⏳ ${remaining}초 후 투표 가능 — 자유롭게 토론하세요.`;
        }
      }, 1000);
    } else {
      dayPhaseStart = 0; // 낮이 아닌 페이즈에서는 초기화
    }
  }
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
