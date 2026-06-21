// ============================================================
//  에너지 변형 마피아 엔진 (8–12인, 호스트 권위 + 역할 비밀)
// ------------------------------------------------------------
//  중요: 전체 상태 G(역할 포함)는 "호스트만" 보유한다.
//  다른 플레이어에게는 makePublic(G) 의 공개 상태만 전송하고,
//  개인 역할/밤 결과는 _private 큐를 통해 1:1 로 전달한다.
//
//  진영:
//   - 재생에너지(시민/태양광/ESG/원자력) : 가이아 생존 + 모든 화석연료 제거 시 승리
//   - 화석연료(마피아) : 가이아 사망 또는 모든 재생에너지 제거 시 승리
//   - 산업 스파이(중립) : 가이아 사망 시점에 에너지 15 이상이면 단독 승리
// ============================================================

export const ROLE = {
  CITIZEN: 'citizen',   // 재생에너지(일반)
  DOCTOR: 'doctor',     // 태양광 패널
  ESG: 'esg',           // ESG 회사
  HACKER: 'hacker',     // 원자력 에너지
  FOSSIL: 'fossil',     // 화석연료(마피아)
  SPY: 'spy',           // 산업 스파이
};
export const ROLE_KO = {
  citizen: '재생에너지', doctor: '태양광 패널(의사)', esg: 'ESG 회사',
  hacker: '원자력 에너지(해커)', fossil: '화석연료(마피아)', spy: '산업 스파이',
};
export const ROLE_DESC = {
  citizen: '특수 능력은 없지만 토론과 투표로 화석연료를 찾아내세요. 매 아침 세금 2에너지를 냅니다.',
  doctor: '매일 밤 재생에너지 1명을 화석연료의 공격으로부터 보호합니다. (2에너지)',
  esg: '생존 중 매일 밤 가이아의 HP를 0.5 회복시킵니다. (2에너지)',
  hacker: '매일 밤 한 명을 지목해 그가 이 라운드에 주고받은 메시지를 가로챕니다. (2에너지)',
  fossil: '매일 밤 한 명을 공격해 제거합니다. 서로의 정체를 모릅니다. (2에너지)',
  spy: '매일 밤 한 명의 에너지를 훔칩니다. 가이아 사망 시 에너지 15+ 보유 시 단독 승리.',
};
export const SPY_WIN_ENERGY = 15;
export const GAIA_MAX_HP = 3;
export const ABILITY_COST = 2;
export const TAX = 2;

const RENEW_TEAM = [ROLE.CITIZEN, ROLE.DOCTOR, ROLE.ESG, ROLE.HACKER];
export function isRenewTeam(role) { return RENEW_TEAM.includes(role); }

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export function createInitialState(hostId, hostName) {
  return {
    game: 'mafia',
    phase: 'lobby',          // lobby → night → day → over
    round: 0,
    hostId,
    gaiaHP: GAIA_MAX_HP,
    players: [],             // {id,name,alive,energy,revealedRole?}
    roles: {},               // host-only: id → role
    votes: {},               // voterId → targetId
    night: { targets: {}, submitted: [], resolved: false }, // host-only
    dmLog: {},               // host-only: round → [{from,to,text}]
    publicChat: [],          // {name,text,round,phase}
    log: ['방이 생성되었습니다. 8명 이상 모이면 방장이 시작할 수 있습니다.'],
    winner: null, winnerTeam: null,
    _private: [],
  };
}

function plog(G, m) { G.log.push(m); if (G.log.length > 120) G.log.shift(); }
function priv(G, to, text, tag = 'info', data = null) { G._private.push({ to, text, tag, data }); }
function P(G, id) { return G.players.find((p) => p.id === id); }
function aliveOf(G, pred) { return G.players.filter((p) => p.alive && pred(G.roles[p.id])); }

// ---------- 공개 상태 투영 (역할/밤정보 제거) ----------
export function makePublic(G) {
  const expected = expectedNightActors(G);
  return {
    game: 'mafia', phase: G.phase, round: G.round, hostId: G.hostId,
    gaiaHP: G.gaiaHP,
    players: G.players.map((p) => ({
      id: p.id, name: p.name, alive: p.alive, energy: p.energy,
      revealedRole: p.revealedRole || null,
      isAI: p.isAI || false,
    })),
    votes: G.votes,
    publicChat: G.publicChat.slice(-120),
    log: G.log.slice(-120),
    winner: G.winner, winnerTeam: G.winnerTeam,
    nightProgress: { done: G.night.submitted.length, total: expected.length },
    counts: liveCounts(G),
    // 게임 종료 시에만 전체 역할 공개
    rolesReveal: G.phase === 'over' ? { ...G.roles } : null,
  };
}

function liveCounts(G) {
  return {
    alive: G.players.filter((p) => p.alive).length,
    fossils: aliveOf(G, (r) => r === ROLE.FOSSIL).length,
    renew: aliveOf(G, isRenewTeam).length,
  };
}

function expectedNightActors(G) {
  if (G.phase !== 'night') return [];
  return G.players.filter((p) => p.alive && [ROLE.FOSSIL, ROLE.DOCTOR, ROLE.HACKER, ROLE.SPY].includes(G.roles[p.id]));
}

// ---------- 역할 배정 ----------
function assignRoles(G) {
  const ids = shuffle(G.players.map((p) => p.id));
  const n = ids.length;
  const fossils = n >= 11 ? 3 : 2;
  const deck = [];
  for (let i = 0; i < fossils; i++) deck.push(ROLE.FOSSIL);
  deck.push(ROLE.DOCTOR, ROLE.ESG, ROLE.HACKER, ROLE.SPY);
  while (deck.length < n) deck.push(ROLE.CITIZEN);
  shuffle(deck);
  G.roles = {};
  ids.forEach((id, i) => { G.roles[id] = deck[i]; });
}

// ============================================================
//  applyAction (호스트에서만 G 를 직접 변경)
// ============================================================
export function applyAction(G, action) {
  const id = action.playerId;

  switch (action.type) {
    case 'JOIN': {
      if (G.phase !== 'lobby') return G;
      if (!P(G, id)) {
        if (G.players.length >= 12) { return G; }
        G.players.push({ id, name: action.name || '플레이어', alive: true, energy: 2 });
      }
      return G;
    }
    case 'LEAVE': {
      if (G.phase === 'lobby') G.players = G.players.filter((p) => p.id !== id);
      return G;
    }
    case 'ADD_AI': {
      if (id !== G.hostId || G.phase !== 'lobby') return G;
      if (G.players.length >= 12) return G;
      G.players.push({ id: action.aiId, name: action.aiName, alive: true, energy: 2, isAI: true });
      plog(G, `🤖 AI 플레이어 '${action.aiName}' 참가.`);
      return G;
    }
    case 'REMOVE_AI': {
      if (id !== G.hostId || G.phase !== 'lobby') return G;
      const ai = G.players.find((p) => p.id === action.aiId && p.isAI);
      if (ai) { G.players = G.players.filter((p) => p.id !== action.aiId); plog(G, `🤖 AI '${ai.name}' 제거됨.`); }
      return G;
    }
    case 'START': {
      if (G.phase !== 'lobby' || id !== G.hostId) return G;
      if (G.players.length < 8) { plog(G, '최소 8명이 필요합니다.'); return G; }
      assignRoles(G);
      G.players.forEach((p) => { p.energy = 2; });
      // 개인 역할 통지
      G.players.forEach((p) => {
        const r = G.roles[p.id];
        priv(G, p.id, `당신의 역할: ${ROLE_KO[r]} — ${ROLE_DESC[r]}`, 'role', { role: r });
      });
      G.round = 1; G.phase = 'night';
      G.night = { targets: {}, submitted: [], resolved: false };
      plog(G, `🌙 게임 시작! 1일차 밤. 특수 직업은 능력을 사용하세요. (화석연료 ${G.players.filter(p=>G.roles[p.id]===ROLE.FOSSIL).length}명)`);
      return G;
    }
    case 'CHAT': {
      const me = P(G, id);
      if (!me) return G;
      // 사망자는 공개 채팅 불가(낮에만 생존자 발언)
      if (!me.alive) return G;
      G.publicChat.push({ name: me.name, text: String(action.text).slice(0, 300), round: G.round, phase: G.phase });
      if (G.publicChat.length > 200) G.publicChat.shift();
      return G;
    }
    case 'DM': {
      const me = P(G, id), to = P(G, action.to);
      if (!me || !to || !me.alive) return G;
      const text = String(action.text).slice(0, 300);
      G.dmLog[G.round] = G.dmLog[G.round] || [];
      G.dmLog[G.round].push({ from: id, to: action.to, text, phase: G.phase });
      priv(G, id, `(→${to.name}) ${text}`, 'dm');
      priv(G, action.to, `(익명→나) ${text}`, 'dm', { fromId: id }); // 수신자는 발신자 모름
      return G;
    }
    case 'NIGHT_ACTION': {
      if (G.phase !== 'night') return G;
      const me = P(G, id);
      if (!me || !me.alive) return G;
      const role = G.roles[id];
      if (![ROLE.FOSSIL, ROLE.DOCTOR, ROLE.HACKER, ROLE.SPY].includes(role)) return G;
      G.night.targets[id] = action.target;     // 대상 플레이어 id
      if (!G.night.submitted.includes(id)) G.night.submitted.push(id);
      priv(G, id, `밤 행동 접수: 대상 ${P(G, action.target)?.name || '?'}`, 'info');
      maybeResolveNight(G);
      return G;
    }
    case 'RESOLVE_NIGHT': {
      if (G.phase !== 'night' || id !== G.hostId) return G;
      resolveNight(G);
      return G;
    }
    case 'VOTE': {
      if (G.phase !== 'day') return G;
      const me = P(G, id);
      if (!me || !me.alive) return G;
      G.votes[id] = action.target;            // 대상 id 또는 'skip'
      maybeResolveDay(G);
      return G;
    }
    case 'RESOLVE_DAY': {
      if (G.phase !== 'day' || id !== G.hostId) return G;
      resolveDay(G);
      return G;
    }
    default: return G;
  }
}

// ---------- 밤 해결 ----------
function maybeResolveNight(G) {
  const expected = expectedNightActors(G).map((p) => p.id);
  if (expected.every((eid) => G.night.submitted.includes(eid))) resolveNight(G);
}

function resolveNight(G) {
  if (G.phase !== 'night' || G.night.resolved) return;
  G.night.resolved = true;
  const t = G.night.targets;

  // 능력 비용 차감 & 효과 수집
  const attacks = [];
  let protectId = null;

  G.players.forEach((p) => {
    if (!p.alive) return;
    const role = G.roles[p.id];
    const target = t[p.id];
    if (role === ROLE.FOSSIL && target) {
      if (p.energy >= ABILITY_COST) { p.energy -= ABILITY_COST; attacks.push(target); }
      else priv(G, p.id, '에너지가 부족해 공격하지 못했습니다.', 'warn');
    } else if (role === ROLE.DOCTOR && target) {
      if (p.energy >= ABILITY_COST) { p.energy -= ABILITY_COST; protectId = target; }
      else priv(G, p.id, '에너지가 부족해 보호하지 못했습니다.', 'warn');
    } else if (role === ROLE.HACKER && target) {
      if (p.energy >= ABILITY_COST) {
        p.energy -= ABILITY_COST;
        const dms = (G.dmLog[G.round] || []).filter((d) => d.from === target || d.to === target);
        const tn = P(G, target)?.name;
        if (dms.length) {
          const lines = dms.map((d) => `  ${P(G, d.from)?.name}→${P(G, d.to)?.name}: ${d.text}`).join('\n');
          priv(G, p.id, `📡 ${tn}의 통신 감청 결과:\n${lines}`, 'hack');
        } else priv(G, p.id, `📡 ${tn}은(는) 이 라운드에 메시지를 주고받지 않았습니다.`, 'hack');
      } else priv(G, p.id, '에너지가 부족해 감청하지 못했습니다.', 'warn');
    } else if (role === ROLE.SPY && target) {
      const victim = P(G, target);
      if (victim && victim.alive) {
        const steal = Math.min(3, victim.energy);
        victim.energy -= steal; p.energy += steal;
        priv(G, p.id, `💰 ${victim.name}에게서 에너지 ${steal} 탈취. (현재 ${p.energy})`, 'spy');
      }
    }
  });

  // ESG 자동 회복
  aliveOf(G, (r) => r === ROLE.ESG).forEach((p) => {
    if (p.energy >= ABILITY_COST) { p.energy -= ABILITY_COST; G.gaiaHP = Math.min(GAIA_MAX_HP, G.gaiaHP + 0.5); priv(G, p.id, '🌱 가이아 HP를 0.5 회복했습니다.', 'info'); }
  });

  // 공격 해결 (보호 대상 제외)
  const killed = [];
  [...new Set(attacks)].forEach((targetId) => {
    if (targetId === protectId) { priv(G, protectId, '🛡️ 누군가의 보호로 공격에서 살아남았습니다!', 'save'); return; }
    const victim = P(G, targetId);
    if (victim && victim.alive) { victim.alive = false; victim.revealedRole = G.roles[victim.id]; killed.push(victim); }
  });

  plog(G, `☀️ ${G.round}일차 아침이 밝았습니다.`);
  if (killed.length) killed.forEach((v) => plog(G, `💀 ${v.name} 님이 밤사이 제거되었습니다. (정체: ${ROLE_KO[v.revealedRole]})`));
  else plog(G, '🌼 밤사이 아무도 죽지 않았습니다.');

  // 아침: 에너지 생산(주사위) + 세금
  morning(G);
  if (checkWin(G)) return;

  // 낮으로 전환
  G.phase = 'day';
  G.votes = {};
  plog(G, '🗳️ 낮 토론을 시작합니다. 의심되는 화석연료를 찾아 투표하세요.');
}

function morning(G) {
  // 주사위 에너지 생산
  G.players.filter((p) => p.alive).forEach((p) => {
    const roll = 1 + Math.floor(Math.random() * 6);
    p.energy += roll;
    priv(G, p.id, `🎲 에너지 생산: +${roll} (현재 ${p.energy})`, 'info');
  });
  // 세금: 재생에너지 진영 생존자 각 2
  const taxers = aliveOf(G, isRenewTeam);
  let paid = 0; const required = taxers.length * TAX;
  taxers.forEach((p) => { const pay = Math.min(TAX, p.energy); p.energy -= pay; paid += pay; });
  if (paid < required) {
    G.gaiaHP -= 0.5;
    plog(G, `🪫 가이아 유지 세금이 부족했습니다(${paid}/${required}). 가이아 HP -0.5 → ${G.gaiaHP}`);
  } else {
    plog(G, `🌍 가이아 유지 세금 납부 완료(${paid} 에너지). 가이아 HP ${G.gaiaHP}`);
  }
}

// ---------- 낮(투표) 해결 ----------
function maybeResolveDay(G) {
  const voters = G.players.filter((p) => p.alive).map((p) => p.id);
  if (voters.every((vid) => vid in G.votes)) resolveDay(G);
}

function resolveDay(G) {
  if (G.phase !== 'day') return;
  const tally = {};
  Object.values(G.votes).forEach((tid) => { if (tid && tid !== 'skip') tally[tid] = (tally[tid] || 0) + 1; });
  let top = null, max = 0, tie = false;
  for (const tid in tally) {
    if (tally[tid] > max) { max = tally[tid]; top = tid; tie = false; }
    else if (tally[tid] === max) tie = true;
  }
  if (!top || tie || max === 0) {
    plog(G, '⚖️ 투표 결과 동률/기권으로 아무도 추방되지 않았습니다.');
  } else {
    const v = P(G, top); v.alive = false; v.revealedRole = G.roles[top];
    plog(G, `🔨 투표로 ${v.name} 님이 추방되었습니다. (정체: ${ROLE_KO[v.revealedRole]})`);
  }
  if (checkWin(G)) return;

  // 다음 밤
  G.round += 1; G.phase = 'night';
  G.votes = {};
  G.night = { targets: {}, submitted: [], resolved: false };
  plog(G, `🌙 ${G.round}일차 밤이 되었습니다.`);
}

// ---------- 승리 판정 ----------
export function checkWin(G) {
  if (G.winner || G.winnerTeam) return true;
  const fossils = aliveOf(G, (r) => r === ROLE.FOSSIL).length;
  const renew = aliveOf(G, isRenewTeam).length;

  if (G.gaiaHP <= 0) {
    const spyWinner = aliveOf(G, (r) => r === ROLE.SPY).find((p) => p.energy >= SPY_WIN_ENERGY);
    if (spyWinner) { G.winnerTeam = 'spy'; G.winner = spyWinner.id; plog(G, `🕵️ 가이아 사망! 산업 스파이 ${spyWinner.name}이(가) 에너지 ${spyWinner.energy}로 단독 승리!`); }
    else { G.winnerTeam = 'fossil'; plog(G, '🛢️ 가이아가 사망했습니다! 화석연료 진영 승리!'); }
    G.phase = 'over'; return true;
  }
  if (fossils === 0) { G.winnerTeam = 'renewable'; G.phase = 'over'; plog(G, '🌳 모든 화석연료를 제거했습니다! 재생에너지 진영 승리!'); return true; }
  if (renew === 0) { G.winnerTeam = 'fossil'; G.phase = 'over'; plog(G, '🛢️ 모든 재생에너지가 제거되었습니다! 화석연료 진영 승리!'); return true; }
  return false;
}
