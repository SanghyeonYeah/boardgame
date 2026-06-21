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
  for (const msg of G._private) {
    if (msg.to === net.id) handlePrivate(msg);
    else net.message({ kind: 'priv', to: msg.to, text: msg.text, tag: msg.tag, data: msg.data });
  }
  G._private = [];
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
  $('wCopy').onclick = () => shareCode(net.code);
  $('wCount').textContent = s.players.length;
  const box = $('wPlayers');
  box.innerHTML = '';
  s.players.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'pm';
    d.innerHTML = `<span class="nm">${p.name}${p.id === net.id ? ' (나)' : ''}</span>${p.id === s.hostId ? '<span class="role">방장</span>' : ''}`;
    box.appendChild(d);
  });
  const start = $('wStart');
  if (net.isHost) {
    start.classList.remove('hidden');
    start.disabled = s.players.length < 8;
    start.onclick = () => net.dispatch({ type: 'START', playerId: net.id });
    $('wHint').textContent = s.players.length < 8 ? `8명 이상 필요 (현재 ${s.players.length})` : '시작 준비 완료!';
  } else {
    start.classList.add('hidden');
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
    d.innerHTML = `<span class="nm">${p.name}${p.id === net.id ? ' (나)' : ''}</span>
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
  s.players.filter((p) => p.id !== net.id).forEach((p) => {
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

// 밤/라운드 전환 시 내 지목 초기화
let prevKey = '';
const origOnState = net.onState;
net.onState = (s) => {
  const key = s ? `${s.phase}:${s.round}` : '';
  if (key !== prevKey) { myNightTarget = null; prevKey = key; }
  origOnState(s);
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
