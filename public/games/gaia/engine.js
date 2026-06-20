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

// 진영별 초기 기물 (협상가는 외교관과 동일 → diplo 로 합산)
const INIT_PIECES = {
  North: { fossil: 6, renew: 5, diplo: 4 },
  South: { fossil: 3, renew: 10, diplo: 2 },
  East:  { fossil: 3, renew: 6, diplo: 6 },
  West:  { fossil: 3, renew: 8, diplo: 4 },
};

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
function spawnBlock(faction) {
  const cells = [];
  if (faction === 'North') for (let y = 0; y <= 2; y++) for (let x = 6; x <= 10; x++) cells.push([x, y]);
  if (faction === 'South') for (let y = 14; y <= 16; y++) for (let x = 6; x <= 10; x++) cells.push([x, y]);
  if (faction === 'East')  for (let x = 14; x <= 16; x++) for (let y = 6; y <= 10; y++) cells.push([x, y]);
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

  // 기물 배치
  active.forEach((f) => {
    s.factions[f] = { score: 0, allies: [] };
    const block = spawnBlock(f);
    const list = [];
    const c = INIT_PIECES[f];
    for (let i = 0; i < c.fossil; i++) list.push('fossil');
    for (let i = 0; i < c.renew; i++) list.push('renew');
    for (let i = 0; i < c.diplo; i++) list.push('diplo');
    list.forEach((type, i) => {
      const [x, y] = block[i] || block[block.length - 1];
      s.pieces.push({ id: id++, faction: f, type, x, y, dir: 4 });
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
  if (areAllies(s, piece.faction, occ.faction)) return { ok: false };
  // 적 기물이 있는 경우
  if (piece.type === 'diplo') return { ok: false }; // 외교관은 점령 불가(인접만)
  if (piece.type === 'renew') {
    if (occ.type === 'fossil') return { ok: false };      // 재생 < 화석
    if (occ.type === 'renew') return { ok: true, kind: 'capture', value: 2 };
    if (occ.type === 'diplo') return { ok: true, kind: 'capture', value: 1 };
  }
  if (piece.type === 'fossil') {
    if (occ.type === 'renew') return { ok: true, kind: 'capture', value: 5 }; // 규칙7
    if (occ.type === 'fossil') return { ok: true, kind: 'capture', value: 2 };
    if (occ.type === 'diplo') return { ok: true, kind: 'capture', value: 1 };
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
    s.pieces = s.pieces.filter((p) => p !== victim);
    s.factions[faction].score += res.value;
    const vName = victim.type === 'renew' ? '재생에너지' : victim.type === 'fossil' ? '화석연료' : '외교관';
    pushLog(s, `⚔️ ${FACTION_KO[faction]}의 ${typeKo(piece.type)}이(가) ${FACTION_KO[victim.faction]}의 ${vName}을(를) 격파! (+${res.value}자원)`);
  }

  piece.x = tx; piece.y = ty;

  // 자원 수집
  const ri = resourceIndexAt(s, tx, ty);
  if (ri !== -1) {
    s.resources.splice(ri, 1);
    s.factions[faction].score += 1;
    pushLog(s, `💎 ${FACTION_KO[faction]}이(가) 자원 1개를 확보했습니다. (총 ${s.factions[faction].score})`);
  }

  // 외교관 인접 → 외교 가능 표시(실제 제안은 PROPOSE 액션)
  if (piece.type === 'diplo') {
    const enemies = adjacentEnemyDiplo(s, piece);
    if (enemies.length) {
      pushLog(s, `🤝 ${FACTION_KO[faction]} 외교관이 ${enemies.map((e) => FACTION_KO[e]).join(', ')} 외교관과 인접했습니다. (외교 제안 가능)`);
    }
  }
}

function typeKo(t) { return t === 'fossil' ? '화석연료' : t === 'renew' ? '재생에너지' : '외교관'; }

// ---------- 화석연료 생성 (자원 2개 소모) ----------
function doCreateFossil(s, faction) {
  if (s.factions[faction].score < 2) { pushLog(s, `자원이 부족합니다(2 필요).`); return; }
  if (fossilCount(s, faction) >= MAX_FOSSIL) { pushLog(s, `화석연료가 최대치(${MAX_FOSSIL})입니다.`); return; }
  // 진영 가장자리 밴드에서 빈 칸 탐색(중앙에서 가까운 순)
  const band = factionBand(faction);
  let spot = null;
  for (const [x, y] of band) {
    if (!pieceAt(s, x, y) && !infraCovering(s, x, y)) { spot = [x, y]; break; }
  }
  if (!spot) { pushLog(s, `생성할 빈 공간이 없습니다.`); return; }
  s.factions[faction].score -= 2;
  s.pieces.push({ id: s.nextId++, faction, type: 'fossil', x: spot[0], y: spot[1], dir: 4 });
  pushLog(s, `🛢️ ${FACTION_KO[faction]}이(가) 자원 2개로 화석연료를 생성했습니다.`);
}

// ---------- 외교 제안 ----------
function doPropose(s, action, faction) {
  const { toFaction, kind } = action;
  if (!s.pickOrder.includes(toFaction) || toFaction === faction) return;
  // 외교관 인접 조건 확인
  const myDiplos = s.pieces.filter((p) => p.faction === faction && p.type === 'diplo');
  const adjacent = myDiplos.some((d) => adjacentEnemyDiplo(s, d).includes(toFaction));
  if (!adjacent) { pushLog(s, `외교관이 ${FACTION_KO[toFaction]} 외교관과 인접해 있지 않습니다.`); return; }
  if (kind === 'alliance' && activePlayerCount(s) <= 2) {
    pushLog(s, `2인 플레이에서는 동맹을 맺을 수 없습니다.`); return;
  }
  const pid = s.nextId++;
  s.pending.push({ id: pid, from: faction, to: toFaction, kind });
  pushLog(s, `📨 ${FACTION_KO[faction]} → ${FACTION_KO[toFaction]} : ${kind === 'alliance' ? '동맹' : '자원 거래'} 제안`);
}

function resolveProposal(s, action) {
  const idx = s.pending.findIndex((p) => p.id === action.pendingId);
  if (idx === -1) return s;
  const p = s.pending[idx];
  // 응답자는 to 진영의 플레이어여야 함
  if (s.seats[p.to] !== action.playerId) return s;
  s.pending.splice(idx, 1);

  if (!action.accept) {
    pushLog(s, `❌ ${FACTION_KO[p.to]}이(가) ${FACTION_KO[p.from]}의 제안을 거절했습니다.`);
    return s;
  }

  if (p.kind === 'trade') {
    // 거래: 양측 +2 자원(시장 가치 창출), 동부는 +1 보너스
    s.factions[p.from].score += 2;
    s.factions[p.to].score += 2;
    if (p.from === 'East') s.factions[p.from].score += 1;
    if (p.to === 'East') s.factions[p.to].score += 1;
    pushLog(s, `💱 ${FACTION_KO[p.from]} ↔ ${FACTION_KO[p.to]} 자원 거래 성사! (각 +2자원)`);
  } else if (p.kind === 'alliance') {
    if (!s.factions[p.from].allies.includes(p.to)) s.factions[p.from].allies.push(p.to);
    if (!s.factions[p.to].allies.includes(p.from)) s.factions[p.to].allies.push(p.from);
    s.factions[p.from].score += 1;
    s.factions[p.to].score += 1;
    pushLog(s, `🕊️ ${FACTION_KO[p.from]} ↔ ${FACTION_KO[p.to]} 동맹 결성! (각 +1자원, 상호 공격 불가)`);
  }
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
      pushLog(s, `🔥 [기후 변수] ${FACTION_KO[faction]}의 재생에너지가 화석연료로 강제 전환되었습니다!`);
      randomNudge(s, p);
    }
  }

  // [이벤트4] 화석연료 과다 → 초대형 인프라 생성
  tryFormInfra(s, faction, m);

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
  if (fc < 8) return;
  if (infraCount(s, faction) >= MAX_INFRA_PER_FACTION) return;
  if (totalInfra(s) >= 9) return;
  const chance = Math.min(0.5, (fc / MAX_FOSSIL) * 0.3 * m);
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
