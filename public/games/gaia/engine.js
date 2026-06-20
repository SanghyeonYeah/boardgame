// ============================================================
//  가이아 게임 엔진 (순수 로직, 호스트에서 실행)
// ------------------------------------------------------------
//  보드: 17×17. 네 진영(북/남/동/서)이 가장자리에서 시작.
//  턴제 + 40분 타이머. 자원을 가장 많이 모으는 진영이 승리.
//  화석연료>재생에너지, 외교관은 싸우지 않고 거래/동맹.
//  초대형 인프라(3×3) 생성·붕괴, 돌발 이동, 기후 변수 등.
// ============================================================

export const SIZE = 17;
export const GAME_MINUTES = 40;
export const FACTIONS = ['North', 'South', 'East', 'West'];
export const FACTION_KO = { North: '북부', South: '남부', East: '동부', West: '서부' };
export const FACTION_COLOR = { North: '#60a5fa', South: '#fbbf24', East: '#f472b6', West: '#a78bfa' };
export const MAX_FOSSIL = 40;
export const MAX_INFRA_PER_FACTION = 3;
export const INFRA_COLLAPSE_AT = 5;

export const DIPLO_FEE = 2; // 외교 비용 (거래·동맹 성사 시 양측 각자 차감)

// 진영별 초기 기물 수 (협상가는 diplo 로 합산)
const INIT_PIECES = {
  North: { fossil: 6, renew: 5, diplo: 4 },  // 외교관 2 + 협상가 2
  South: { fossil: 3, renew: 10, diplo: 2 },
  East:  { fossil: 3, renew: 6,  diplo: 6 },
  West:  { fossil: 3, renew: 8,  diplo: 4 },
};

// 진영 초기 방향: 중앙을 향하는 DIRS 인덱스 (화력발전소 정면 포획에 사용)
const FACTION_INIT_DIR = { North: 6, South: 1, East: 3, West: 4 };

// 진영별 돌발/전환 확률 배수 (서부가 모든 이벤트 확률이 높음)
const EVENT_MULT = { North: 1, South: 1, East: 1, West: 2.6 };

// 8방향
const DIRS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

function rnd(n) { return Math.floor(Math.random() * n); }
function inBounds(x, y) { return x >= 0 && y >= 0 && x < SIZE && y < SIZE; }

// ---------- 진영 영역/스폰 정의 ----------
// 각 진영의 초기 기물 블록(5열) 좌표 모음
// 스폰 블록: 끝줄(플레이어 기준 바로 앞)부터 중앙 방향 순서로 15칸
// fossil → renew → diplo 순으로 채우면 끝줄=화력발전소, 중간=재생에너지, 앞=외교관
function spawnBlock(faction) {
  const cells = [];
  if (faction === 'North') for (let y = 0; y <= 2; y++) for (let x = 6; x <= 10; x++) cells.push([x, y]);
  if (faction === 'South') for (let y = 16; y >= 14; y--) for (let x = 6; x <= 10; x++) cells.push([x, y]);
  if (faction === 'East')  for (let x = 16; x >= 14; x--) for (let y = 6; y <= 10; y++) cells.push([x, y]);
  if (faction === 'West')  for (let x = 0; x <= 2; x++) for (let y = 6; y <= 10; y++) cells.push([x, y]);
  return cells;
}

// 초대형 인프라 3×3 의 좌상단(진영 중앙 시작점)
export function infraAnchor(faction) {
  if (faction === 'North') return { x: 7, y: 0 };
  if (faction === 'South') return { x: 7, y: 14 };
  if (faction === 'East')  return { x: 14, y: 7 };
  if (faction === 'West')  return { x: 0, y: 7 };
}

function regionOf(x, y) {
  if (y <= 3) return 'North';
  if (y >= 13) return 'South';
  if (x <= 3) return 'West';
  if (x >= 13) return 'East';
  return 'Center';
}

// 진영 가장자리 밴드(생성/스폰용 넓은 영역) — 인프라 중앙에서 가까운 순으로 정렬
function factionBand(faction) {
  const cells = [];
  if (faction === 'North') for (let y = 0; y <= 3; y++) for (let x = 0; x < SIZE; x++) cells.push([x, y]);
  if (faction === 'South') for (let y = 13; y <= 16; y++) for (let x = 0; x < SIZE; x++) cells.push([x, y]);
  if (faction === 'East')  for (let x = 13; x <= 16; x++) for (let y = 0; y < SIZE; y++) cells.push([x, y]);
  if (faction === 'West')  for (let x = 0; x <= 3; x++) for (let y = 0; y < SIZE; y++) cells.push([x, y]);
  const a = infraAnchor(faction);
  cells.sort((p, q) => (Math.abs(p[0] - a.x) + Math.abs(p[1] - a.y)) - (Math.abs(q[0] - a.x) + Math.abs(q[1] - a.y)));
  return cells;
}

// ---------- 초기 상태 (픽 단계) ----------
export function createInitialState(hostId, hostName) {
  return {
    game: 'gaia',
    phase: 'pick',                 // pick → play → over
    hostId,
    seats: { North: null, South: null, East: null, West: null },
    seatNames: {},
    pickOrder: [],                 // 선택된 진영 순서 = 턴 순서
    size: SIZE,
    resources: [],
    pieces: [],
    infra: [],
    factions: {},
    nextId: 1,
    turnIndex: 0,
    endsAt: null,
    pending: [],                   // 외교 제안 목록
    winner: null,
    log: [`방이 생성되었습니다. 진영을 선택하세요. (방장: ${hostName})`],
  };
}

function pushLog(s, msg) {
  s.log.push(msg);
  if (s.log.length > 80) s.log.shift();
}

// ---------- 보드 생성 (게임 시작 시) ----------
function buildBoard(s) {
  const active = s.pickOrder.slice(); // 선택된 진영들
  const occupied = new Set();
  const key = (x, y) => `${x},${y}`;
  s.pieces = [];
  s.infra = [];
  s.factions = {};
  let id = 1;

  // 기물 배치 — fossil→renew→diplo 순서로 채워 끝줄=화력발전소, 중간=재생에너지, 앞=외교관
  active.forEach((f) => {
    s.factions[f] = { score: 0, allies: [] };
    const block = spawnBlock(f);
    const c = INIT_PIECES[f];
    const list = [];
    for (let i = 0; i < c.fossil; i++) list.push('fossil');
    for (let i = 0; i < c.renew; i++) list.push('renew');
    for (let i = 0; i < c.diplo; i++) list.push('diplo');
    const initDir = FACTION_INIT_DIR[f] ?? 4;
    list.forEach((type, i) => {
      const [x, y] = block[i] ?? block[block.length - 1];
      s.pieces.push({ id: id++, faction: f, type, x, y, dir: initDir });
      occupied.add(key(x, y));
    });
  });

  // 자원 배치 (영역 가중치) — 남부 최다, 서부 최소
  const weights = { North: 18, South: 45, East: 30, West: 9, Center: 48 };
  const cellsByRegion = { North: [], South: [], East: [], West: [], Center: [] };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (occupied.has(key(x, y))) continue;
      cellsByRegion[regionOf(x, y)].push([x, y]);
    }
  }
  const res = [];
  const placeIn = (region, n) => {
    const pool = cellsByRegion[region];
    let placed = 0, guard = 0;
    while (placed < n && pool.length && guard++ < 5000) {
      const idx = rnd(pool.length);
      const [x, y] = pool[idx];
      pool.splice(idx, 1);
      res.push({ x, y });
      occupied.add(key(x, y));
      placed++;
    }
  };
  // 활성 진영 영역엔 가중치 그대로, 비활성 진영 영역의 자원은 중앙으로 흡수
  let total = 150;
  const regions = ['North', 'South', 'East', 'West', 'Center'];
  let wsum = regions.reduce((a, r) => a + weights[r], 0);
  regions.forEach((r) => {
    const n = Math.round((weights[r] / wsum) * total);
    placeIn(r, n);
  });
  // 부족분 보충
  while (res.length < 150) {
    placeIn('Center', 1);
    if (cellsByRegion.Center.length === 0) break;
  }
  s.resources = res;
  s.nextId = id;
}

// ---------- 조회 헬퍼 ----------
function pieceAt(s, x, y) { return s.pieces.find((p) => p.x === x && p.y === y); }
function infraCovering(s, x, y) {
  return s.infra.find((g) => x >= g.x && x < g.x + 3 && y >= g.y && y < g.y + 3);
}

// 기물 이전: fromFaction의 pieceType count개를 toFaction 스폰존에 새로 생성
function transferPieces(s, fromFaction, toFaction, pieceType, count) {
  let removed = 0;
  const toRemove = [];
  for (const p of s.pieces) {
    if (removed >= count) break;
    if (p.faction === fromFaction && p.type === pieceType) { toRemove.push(p.id); removed++; }
  }
  s.pieces = s.pieces.filter((p) => !toRemove.includes(p.id));
  const band = factionBand(toFaction);
  for (let i = 0; i < removed; i++) {
    for (const [x, y] of band) {
      if (!pieceAt(s, x, y) && !infraCovering(s, x, y)) {
        s.pieces.push({ id: s.nextId++, faction: toFaction, type: pieceType, x, y, dir: FACTION_INIT_DIR[toFaction] ?? 4 });
        break;
      }
    }
  }
  return removed;
}
function resourceIndexAt(s, x, y) { return s.resources.findIndex((r) => r.x === x && r.y === y); }
function fossilCount(s, f) { return s.pieces.filter((p) => p.faction === f && p.type === 'fossil').length; }
function areAllies(s, a, b) {
  return s.factions[a]?.allies?.includes(b);
}

export function activePlayerCount(s) {
  return Object.values(s.seats).filter(Boolean).length;
}
export function currentFaction(s) {
  if (s.phase !== 'play' || s.pickOrder.length === 0) return null;
  return s.pickOrder[s.turnIndex % s.pickOrder.length];
}

// ---------- 이동 유효성 ----------
export function legalMovesFor(s, piece) {
  const moves = [];
  const [fdx, fdy] = DIRS[piece.dir] ?? DIRS[4];
  for (const [dx, dy] of DIRS) {
    const tx = piece.x + dx, ty = piece.y + dy;
    if (!inBounds(tx, ty)) continue;
    const r = canMoveInto(s, piece, tx, ty);
    if (!r.ok) continue;
    // 화석연료가 재생에너지를 잡는 건 정면 1칸만 허용
    if (piece.type === 'fossil' && r.kind === 'capture') {
      const target = pieceAt(s, tx, ty);
      if (target?.type === 'renew' && !(dx === fdx && dy === fdy)) continue;
    }
    moves.push({ tx, ty, kind: r.kind, cap: r.kind === 'capture' });
  }
  return moves;
}

// 내 진영 외교관이 인접한 적 외교관 진영 목록
export function diplomacyTargets(s, faction) {
  const out = new Set();
  s.pieces.filter((p) => p.faction === faction && p.type === 'diplo')
    .forEach((d) => adjacentEnemyDiplo(s, d).forEach((f) => out.add(f)));
  return [...out];
}

function canMoveInto(s, piece, tx, ty) {
  if (infraCovering(s, tx, ty)) return { ok: false };
  const occ = pieceAt(s, tx, ty);
  if (!occ) return { ok: true, kind: 'move' };
  if (occ.faction === piece.faction) return { ok: false };
  if (areAllies(s, piece.faction, occ.faction)) {
    // 중앙 중립지역에서 동맹 재생에너지 포획 → 허용하되 동맹 파기 플래그 (정면 필터는 legalMovesFor)
    if (piece.type === 'fossil' && occ.type === 'renew' && regionOf(tx, ty) === 'Center') {
      return { ok: true, kind: 'capture', value: 5, allianceBreak: true };
    }
    return { ok: false };
  }
  // 적 기물이 있는 경우
  if (piece.type === 'diplo') return { ok: false }; // 외교관은 점령 불가(인접만)
  if (piece.type === 'renew') {
    if (occ.type === 'fossil') return { ok: false };      // 재생 < 화석
    if (occ.type === 'renew') return { ok: true, kind: 'capture', value: 2 };
    if (occ.type === 'diplo') return { ok: true, kind: 'capture', value: 1 };
  }
  if (piece.type === 'fossil') {
    if (occ.type === 'renew') return { ok: true, kind: 'capture', value: 5 }; // 규칙7, 정면만 허용(legalMovesFor에서 필터)
    // 화석↔화석, 화석→외교관 포획 불가
  }
  return { ok: false };
}

function dirIndex(dx, dy) {
  for (let i = 0; i < DIRS.length; i++) if (DIRS[i][0] === dx && DIRS[i][1] === dy) return i;
  return 4;
}

// 외교관이 이동 후 인접 8칸에 적 외교관이 있는지
function adjacentEnemyDiplo(s, piece) {
  const out = [];
  for (const [dx, dy] of DIRS) {
    const nx = piece.x + dx, ny = piece.y + dy;
    const occ = pieceAt(s, nx, ny);
    if (occ && occ.type === 'diplo' && occ.faction !== piece.faction) out.push(occ.faction);
  }
  return [...new Set(out)];
}

// ============================================================
//  applyAction : 모든 액션을 처리하는 진입점 (호스트에서 호출)
// ============================================================
export function applyAction(state, action, fromId) {
  const s = structuredClone(state);
  const { type } = action;

  if (type === 'PICK') {
    if (s.phase !== 'pick') return s;
    const f = action.faction;
    if (!FACTIONS.includes(f) || s.seats[f]) return s;
    // 한 사람당 한 진영
    for (const k of FACTIONS) if (s.seats[k] === action.playerId) s.seats[k] = null;
    s.seats[f] = action.playerId;
    s.seatNames[action.playerId] = action.name || '플레이어';
    s.pickOrder = FACTIONS.filter((x) => s.seats[x]);
    pushLog(s, `${action.name || '플레이어'} 님이 ${FACTION_KO[f]} 진영을 선택했습니다.`);
    return s;
  }

  if (type === 'UNPICK') {
    if (s.phase !== 'pick') return s;
    for (const k of FACTIONS) if (s.seats[k] === action.playerId) s.seats[k] = null;
    s.pickOrder = FACTIONS.filter((x) => s.seats[x]);
    return s;
  }

  if (type === 'START') {
    if (s.phase !== 'pick') return s;
    if (action.playerId !== s.hostId) return s;
    if (activePlayerCount(s) < 2) { pushLog(s, '최소 2명이 진영을 선택해야 시작할 수 있습니다.'); return s; }
    buildBoard(s);
    s.phase = 'play';
    s.turnIndex = 0;
    s.endsAt = Date.now() + GAME_MINUTES * 60 * 1000;
    pushLog(s, `게임 시작! 제한 시간 ${GAME_MINUTES}분. ${FACTION_KO[currentFaction(s)]} 진영부터 시작합니다.`);
    return s;
  }

  if (type === 'TICK') {
    // 호스트가 주기적으로 호출 → 시간 종료 체크
    checkTimeOver(s);
    return s;
  }

  if (type === 'RESPOND') {
    return resolveProposal(s, action);
  }

  if (s.phase !== 'play') return s;

  // 턴 검증 (외교 응답 제외, 위에서 처리)
  const cur = currentFaction(s);
  const actorFaction = FACTIONS.find((f) => s.seats[f] === action.playerId);
  if (actorFaction !== cur) { return s; } // 자기 턴 아님

  if (type === 'MOVE') {
    doMove(s, action, actorFaction);
  } else if (type === 'CREATE_FOSSIL') {
    doCreateFossil(s, actorFaction);
  } else if (type === 'PROPOSE') {
    doPropose(s, action, actorFaction);
  } else if (type === 'PASS') {
    pushLog(s, `${FACTION_KO[actorFaction]} 진영이 턴을 넘겼습니다.`);
  } else {
    return s;
  }

  // 액션 후 랜덤 이벤트 → 턴 넘김 → 시간 체크
  if (s.phase === 'play') {
    runEvents(s, actorFaction);
    advanceTurn(s);
    checkTimeOver(s);
  }
  return s;
}

function advanceTurn(s) {
  if (s.pickOrder.length === 0) return;
  s.turnIndex = (s.turnIndex + 1) % s.pickOrder.length;
}

function checkTimeOver(s) {
  if (s.phase !== 'play') return;
  if (s.endsAt && Date.now() >= s.endsAt) {
    finishGame(s, '제한 시간 종료');
  }
}

function finishGame(s, reason) {
  s.phase = 'over';
  let best = null, bestScore = -1, tie = false;
  for (const f of s.pickOrder) {
    const sc = s.factions[f].score;
    if (sc > bestScore) { bestScore = sc; best = f; tie = false; }
    else if (sc === bestScore) tie = true;
  }
  s.winner = tie ? null : best;
  if (tie) pushLog(s, `🏁 ${reason}! 동점으로 무승부입니다. (최고 ${bestScore}자원)`);
  else pushLog(s, `🏁 ${reason}! 승리: ${FACTION_KO[best]} 진영 (${bestScore}자원)`);
}

// ---------- 동맹 파기 ----------
function breakAlliance(s, breaker, victim, reason) {
  if (!areAllies(s, breaker, victim)) return;
  s.factions[breaker].allies = s.factions[breaker].allies.filter((f) => f !== victim);
  s.factions[victim].allies = s.factions[victim].allies.filter((f) => f !== breaker);
  pushLog(s, `⚔️💥 [전쟁 선포!] ${FACTION_KO[breaker]}이(가) ${FACTION_KO[victim]}과(와)의 동맹을 파기했습니다! (${reason}) 합의된 조건에 따라 위약을 처리하세요.`);
}

// ---------- 이동 처리 ----------
function doMove(s, action, faction) {
  const piece = s.pieces.find((p) => p.id === action.pieceId);
  if (!piece || piece.faction !== faction) return;
  const { tx, ty } = action;
  const res = canMoveInto(s, piece, tx, ty);
  if (!res.ok) return;

  piece.dir = dirIndex(tx - piece.x, ty - piece.y);

  if (res.kind === 'capture') {
    const victim = pieceAt(s, tx, ty);
    const victimFaction = victim.faction;
    s.pieces = s.pieces.filter((p) => p !== victim);
    s.factions[faction].score += res.value;
    const vName = victim.type === 'renew' ? '재생에너지' : victim.type === 'fossil' ? '화력 발전소' : '외교관';
    pushLog(s, `⚔️ ${FACTION_KO[faction]}의 ${typeKo(piece.type)}이(가) ${FACTION_KO[victimFaction]}의 ${vName}을(를) 격파! (+${res.value}자원)`);
    if (res.allianceBreak) {
      breakAlliance(s, faction, victimFaction, '중립 지역에서 동맹 재생에너지 포획');
    }
  }

  piece.x = tx; piece.y = ty;

  // 자원 수집 — 동맹 영토 침범 여부 먼저 확인
  const ri = resourceIndexAt(s, tx, ty);
  if (ri !== -1) {
    const region = regionOf(tx, ty);
    const allyBreachTarget = (region !== 'Center' && region !== faction && areAllies(s, faction, region))
      ? region : null;
    s.resources.splice(ri, 1);
    s.factions[faction].score += 1;
    pushLog(s, `💎 ${FACTION_KO[faction]}이(가) 자원 1개를 확보했습니다. (총 ${s.factions[faction].score})`);
    if (allyBreachTarget) {
      breakAlliance(s, faction, allyBreachTarget, `${FACTION_KO[allyBreachTarget]} 진영 영토 침범`);
    }
  }

  // 외교관 인접 → 외교 가능 표시(실제 제안은 PROPOSE 액션)
  if (piece.type === 'diplo') {
    const enemies = adjacentEnemyDiplo(s, piece);
    if (enemies.length) {
      pushLog(s, `🤝 ${FACTION_KO[faction]} 외교관이 ${enemies.map((e) => FACTION_KO[e]).join(', ')} 외교관과 인접했습니다. (외교 제안 가능)`);
    }
  }
}

export function typeKo(t) { return t === 'fossil' ? '화력 발전소' : t === 'renew' ? '재생에너지' : '외교관'; }

// ---------- 화력 발전소 생성 (자원 2개 소모) ----------
function doCreateFossil(s, faction) {
  if (s.factions[faction].score < 2) { pushLog(s, `자원이 부족합니다(2 필요).`); return; }
  if (fossilCount(s, faction) >= MAX_FOSSIL) { pushLog(s, `화력 발전소가 최대치(${MAX_FOSSIL})입니다.`); return; }
  // 진영 가장자리 밴드에서 빈 칸 탐색(중앙에서 가까운 순)
  const band = factionBand(faction);
  let spot = null;
  for (const [x, y] of band) {
    if (!pieceAt(s, x, y) && !infraCovering(s, x, y)) { spot = [x, y]; break; }
  }
  if (!spot) { pushLog(s, `생성할 빈 공간이 없습니다.`); return; }
  s.factions[faction].score -= 2;
  s.pieces.push({ id: s.nextId++, faction, type: 'fossil', x: spot[0], y: spot[1], dir: FACTION_INIT_DIR[faction] ?? 4 });
  pushLog(s, `🛢️ ${FACTION_KO[faction]}이(가) 자원 2개로 화력 발전소를 생성했습니다.`);
}

// ---------- 외교 제안 ----------
function doPropose(s, action, faction) {
  const { toFaction, kind } = action;
  if (!s.pickOrder.includes(toFaction) || toFaction === faction) return;
  const myDiplos = s.pieces.filter((p) => p.faction === faction && p.type === 'diplo');
  const adjacent = myDiplos.some((d) => adjacentEnemyDiplo(s, d).includes(toFaction));
  if (!adjacent) { pushLog(s, `외교관이 ${FACTION_KO[toFaction]} 외교관과 인접해 있지 않습니다.`); return; }
  if (kind === 'alliance' && activePlayerCount(s) <= 2) {
    pushLog(s, `2인 플레이에서는 동맹을 맺을 수 없습니다.`); return;
  }
  const pid = s.nextId++;
  const terms = action.terms ? String(action.terms).slice(0, 200).trim() : '';
  if (kind === 'trade') {
    const ofType = action.fromOfferType === 'piece' ? 'piece' : 'resource';
    const fromOffer = ofType === 'resource'
      ? { type: 'resource', amount: Math.max(0, parseInt(action.fromOfferAmount) || 0) }
      : { type: 'piece', pieceType: action.fromOfferPieceType || 'fossil', pieceCount: Math.max(1, parseInt(action.fromOfferPieceCount) || 1) };
    if (fromOffer.type === 'resource' && s.factions[faction].score < fromOffer.amount) {
      pushLog(s, `💸 자원 부족 (제안: ${fromOffer.amount}, 보유: ${s.factions[faction].score})`); return;
    }
    if (fromOffer.type === 'piece') {
      const have = s.pieces.filter((p) => p.faction === faction && p.type === fromOffer.pieceType).length;
      if (have < fromOffer.pieceCount) { pushLog(s, `💸 ${typeKo(fromOffer.pieceType)} 부족 (제안: ${fromOffer.pieceCount}, 보유: ${have})`); return; }
    }
    const offerDesc = fromOffer.type === 'resource' ? `자원 ${fromOffer.amount}` : `${typeKo(fromOffer.pieceType)} ${fromOffer.pieceCount}개`;
    s.pending.push({ id: pid, from: faction, to: toFaction, kind: 'trade', fromOffer, toOffer: null, terms, status: 'need_counter' });
    pushLog(s, `📨 ${FACTION_KO[faction]} → ${FACTION_KO[toFaction]} : 거래 제안 (제공: ${offerDesc}${terms ? `, 조건: "${terms}"` : ''})`);
  } else {
    const warnings = [];
    if (s.factions[faction].allies.length > 0) warnings.push(`${FACTION_KO[faction]}의 기존 동맹 파기`);
    if (s.factions[toFaction].allies.length > 0) warnings.push(`${FACTION_KO[toFaction]}의 기존 동맹 파기`);
    const warnMsg = warnings.length ? ` ⚠️ 수락 시 → ${warnings.join(', ')}` : '';
    const termsMsg = terms ? ` / 조건: "${terms}"` : '';
    s.pending.push({ id: pid, from: faction, to: toFaction, kind: 'alliance', terms });
    pushLog(s, `📨 ${FACTION_KO[faction]} → ${FACTION_KO[toFaction]} : 동맹 제안${termsMsg}${warnMsg}`);
  }
}

function resolveProposal(s, action) {
  const idx = s.pending.findIndex((p) => p.id === action.pendingId);
  if (idx === -1) return s;
  const p = s.pending[idx];
  const isProposer = s.seats[p.from] === action.playerId;
  const isResponder = s.seats[p.to] === action.playerId;
  if (!isProposer && !isResponder) return s;

  if (p.kind === 'trade') {
    // 1단계: 응답자가 맞거래 제안 또는 거절
    if (p.status === 'need_counter' && isResponder) {
      if (!action.accept) {
        s.pending.splice(idx, 1);
        pushLog(s, `❌ ${FACTION_KO[p.to]}이(가) 거래를 거절했습니다.`);
        return s;
      }
      const toType = action.toOfferType === 'piece' ? 'piece' : 'resource';
      const toOffer = toType === 'resource'
        ? { type: 'resource', amount: Math.max(0, parseInt(action.toOfferAmount) || 0) }
        : { type: 'piece', pieceType: action.toOfferPieceType || 'fossil', pieceCount: Math.max(1, parseInt(action.toOfferPieceCount) || 1) };
      if (toOffer.type === 'resource' && s.factions[p.to].score < toOffer.amount) {
        pushLog(s, `💸 ${FACTION_KO[p.to]} 자원 부족 (필요: ${toOffer.amount})`); return s;
      }
      if (toOffer.type === 'piece') {
        const have = s.pieces.filter((q) => q.faction === p.to && q.type === toOffer.pieceType).length;
        if (have < toOffer.pieceCount) { pushLog(s, `💸 ${FACTION_KO[p.to]} ${typeKo(toOffer.pieceType)} 부족`); return s; }
      }
      p.toOffer = toOffer; p.status = 'need_confirm';
      const toDesc = toOffer.type === 'resource' ? `자원 ${toOffer.amount}` : `${typeKo(toOffer.pieceType)} ${toOffer.pieceCount}개`;
      pushLog(s, `🔄 ${FACTION_KO[p.to]}이(가) 맞거래 제안: ${toDesc} — ${FACTION_KO[p.from]}의 확정 대기`);
      return s;
    }
    // 2단계: 제안자 최종 확정 또는 취소 (양쪽 모두 취소 가능)
    if (p.status === 'need_confirm') {
      s.pending.splice(idx, 1);
      if (!action.accept) {
        pushLog(s, `❌ 거래 취소 (${FACTION_KO[isProposer ? p.from : p.to]})`); return s;
      }
      if (!isProposer) return s;
      const fA = s.factions[p.from], fB = s.factions[p.to];
      // 자원 보유 체크 (외교비 + 자원 제공분)
      const scoreNeedA = DIPLO_FEE + (p.fromOffer.type === 'resource' ? p.fromOffer.amount : 0);
      const scoreNeedB = DIPLO_FEE + (p.toOffer.type === 'resource' ? p.toOffer.amount : 0);
      if (fA.score < scoreNeedA) { pushLog(s, `⚠️ 거래 실패: ${FACTION_KO[p.from]} 자원 부족 (필요 ${scoreNeedA})`); return s; }
      if (fB.score < scoreNeedB) { pushLog(s, `⚠️ 거래 실패: ${FACTION_KO[p.to]} 자원 부족 (필요 ${scoreNeedB})`); return s; }
      // 기물 보유 체크
      if (p.fromOffer.type === 'piece') {
        const have = s.pieces.filter((q) => q.faction === p.from && q.type === p.fromOffer.pieceType).length;
        if (have < p.fromOffer.pieceCount) { pushLog(s, `⚠️ 거래 실패: ${FACTION_KO[p.from]} ${typeKo(p.fromOffer.pieceType)} 부족`); return s; }
      }
      if (p.toOffer.type === 'piece') {
        const have = s.pieces.filter((q) => q.faction === p.to && q.type === p.toOffer.pieceType).length;
        if (have < p.toOffer.pieceCount) { pushLog(s, `⚠️ 거래 실패: ${FACTION_KO[p.to]} ${typeKo(p.toOffer.pieceType)} 부족`); return s; }
      }
      // 외교비 차감
      fA.score -= DIPLO_FEE; fB.score -= DIPLO_FEE;
      // A의 offer 실행
      let fromDesc;
      if (p.fromOffer.type === 'resource') {
        fA.score -= p.fromOffer.amount; fB.score += p.fromOffer.amount;
        fromDesc = `자원 ${p.fromOffer.amount}`;
      } else {
        const n = transferPieces(s, p.from, p.to, p.fromOffer.pieceType, p.fromOffer.pieceCount);
        fromDesc = `${typeKo(p.fromOffer.pieceType)} ${n}개`;
      }
      // B의 offer 실행
      let toDesc;
      if (p.toOffer.type === 'resource') {
        fB.score -= p.toOffer.amount; fA.score += p.toOffer.amount;
        toDesc = `자원 ${p.toOffer.amount}`;
      } else {
        const n = transferPieces(s, p.to, p.from, p.toOffer.pieceType, p.toOffer.pieceCount);
        toDesc = `${typeKo(p.toOffer.pieceType)} ${n}개`;
      }
      const termsMsg = p.terms ? ` / 조건: "${p.terms}"` : '';
      pushLog(s, `✅ 거래 성사! ${FACTION_KO[p.from]}(제공: ${fromDesc}) ↔ ${FACTION_KO[p.to]}(제공: ${toDesc}) [외교비 −${DIPLO_FEE} 각자]${termsMsg}`);
      return s;
    }
    return s;
  }

  // 동맹
  if (!isResponder) return s;
  s.pending.splice(idx, 1);
  if (!action.accept) {
    pushLog(s, `❌ ${FACTION_KO[p.to]}이(가) 동맹을 거절했습니다.`); return s;
  }
  const fA = s.factions[p.from], fB = s.factions[p.to];
  if (fA.score < DIPLO_FEE || fB.score < DIPLO_FEE) {
    pushLog(s, `⚠️ 동맹 실패: 외교 비용(자원 ${DIPLO_FEE}) 부족`); return s;
  }
  fA.score -= DIPLO_FEE; fB.score -= DIPLO_FEE;
  for (const ex of [...(fA.allies || [])]) breakAlliance(s, p.from, ex, `${FACTION_KO[p.to]}과(와) 새 동맹`);
  for (const ex of [...(fB.allies || [])]) breakAlliance(s, p.to, ex, `${FACTION_KO[p.from]}과(와) 새 동맹`);
  if (!fA.allies.includes(p.to)) fA.allies.push(p.to);
  if (!fB.allies.includes(p.from)) fB.allies.push(p.from);
  const allyTerms = p.terms ? ` / 조건: "${p.terms}"` : '';
  pushLog(s, `🕊️ ${FACTION_KO[p.from]} ↔ ${FACTION_KO[p.to]} 동맹 결성! [외교비 −${DIPLO_FEE} 각자]${allyTerms}`);
  return s;
}

// ============================================================
//  랜덤 이벤트 (매 행동 후 호스트가 실행)
// ============================================================
function runEvents(s, faction) {
  const m = EVENT_MULT[faction] || 1;

  // [이벤트1] 재생에너지 강제 화석 전환 + 랜덤 이동
  if (Math.random() < 0.06 * m) {
    const renews = s.pieces.filter((p) => p.faction === faction && p.type === 'renew');
    if (renews.length && fossilCount(s, faction) < MAX_FOSSIL) {
      const p = renews[rnd(renews.length)];
      p.type = 'fossil';
      pushLog(s, `🔥 [기후 변수] ${FACTION_KO[faction]}의 재생에너지가 화력 발전소로 강제 전환되었습니다!`);
      randomNudge(s, p);
    }
  }

  // [이벤트4] 매 턴 모든 진영에 대해 초대형 인프라 진화 확률 체크
  for (const f of Object.keys(s.factions)) {
    tryFormInfra(s, f, EVENT_MULT[f] || 1);
  }

  // [이벤트7] 돌발 이동: 임의 기물이 이상한 방향으로 이동
  if (Math.random() < 0.07 * m) {
    const movable = s.pieces;
    if (movable.length) {
      const p = movable[rnd(movable.length)];
      const before = `${p.x},${p.y}`;
      randomNudge(s, p);
      if (`${p.x},${p.y}` !== before)
        pushLog(s, `🌀 [돌발 상황] ${FACTION_KO[p.faction]}의 ${typeKo(p.type)}이(가) 갑자기 이상한 방향으로 움직였습니다!`);
    }
  }
}

// 빈 인접 칸으로 무작위 이동(점령 없음)
function randomNudge(s, piece) {
  const opts = [];
  for (const [dx, dy] of DIRS) {
    const nx = piece.x + dx, ny = piece.y + dy;
    if (!inBounds(nx, ny)) continue;
    if (pieceAt(s, nx, ny) || infraCovering(s, nx, ny)) continue;
    opts.push([nx, ny]);
  }
  if (!opts.length) return;
  const [nx, ny] = opts[rnd(opts.length)];
  piece.dir = dirIndex(nx - piece.x, ny - piece.y);
  piece.x = nx; piece.y = ny;
  // 이동 후 자원 수집
  const ri = resourceIndexAt(s, nx, ny);
  if (ri !== -1) { s.resources.splice(ri, 1); s.factions[piece.faction].score += 1; }
}

function totalInfra(s) { return s.infra.length; }
function infraCount(s, f) { return s.infra.filter((g) => g.faction === f).length; }

function tryFormInfra(s, faction, m) {
  const fc = fossilCount(s, faction);
  if (fc < 4) return;
  if (infraCount(s, faction) >= MAX_INFRA_PER_FACTION) return;
  if (totalInfra(s) >= 9) return;
  // 기본 2%, 화력 발전소 1개 추가마다 0.5% 증가 (최대 50%)
  const chance = Math.min(0.5, (0.02 + (fc - 4) * 0.005) * m);
  if (Math.random() >= chance) return;

  const a = infraAnchor(faction);
  // 3×3 자리에 적/아군 외 인프라가 없어야 하며, 아군 화석은 흡수
  for (let yy = a.y; yy < a.y + 3; yy++)
    for (let xx = a.x; xx < a.x + 3; xx++) {
      if (!inBounds(xx, yy)) return;
      if (infraCovering(s, xx, yy)) return;
      const occ = pieceAt(s, xx, yy);
      if (occ && occ.faction !== faction) return; // 적 기물이 막고 있으면 실패
    }
  // footprint 내 아군 화석 흡수(병합), 그 외 아군 기물은 밀어내기 시도
  const removeIds = [];
  let absorbed = 0;
  for (const p of s.pieces) {
    if (p.x >= a.x && p.x < a.x + 3 && p.y >= a.y && p.y < a.y + 3) {
      if (p.type === 'fossil' && absorbed < 10) { removeIds.push(p.id); absorbed++; }
      else { // 다른 아군 기물은 인접 빈칸으로 밀어냄
        randomNudge(s, p);
      }
    }
  }
  s.pieces = s.pieces.filter((p) => !removeIds.includes(p.id));
  // footprint 내 자원 수집
  for (let yy = a.y; yy < a.y + 3; yy++)
    for (let xx = a.x; xx < a.x + 3; xx++) {
      const ri = resourceIndexAt(s, xx, yy);
      if (ri !== -1) { s.resources.splice(ri, 1); s.factions[faction].score += 1; }
    }
  s.infra.push({ id: s.nextId++, faction, x: a.x, y: a.y });
  pushLog(s, `🏗️ [초대박] ${FACTION_KO[faction]} 진영에 초대형 에너지 인프라가 건설되었습니다! (전체 ${totalInfra(s)}개)`);

  // [이벤트5] 전체 인프라 5개 도달 → 무작위 3개 붕괴
  if (totalInfra(s) >= INFRA_COLLAPSE_AT) {
    let destroyed = 0;
    while (destroyed < 3 && s.infra.length > 0) {
      const gi = rnd(s.infra.length);
      const g = s.infra[gi];
      s.infra.splice(gi, 1);
      destroyed++;
    }
    pushLog(s, `🌪️ [대재앙] 전 세계 인프라가 ${INFRA_COLLAPSE_AT}개에 도달! 기후 변화로 무작위 ${destroyed}개의 초대형 인프라가 붕괴했습니다!`);
  }
}
