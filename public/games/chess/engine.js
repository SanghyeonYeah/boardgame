// ============================================================
//  에너지 변형 체스 엔진 (2인, 호스트 권위)
// ------------------------------------------------------------
//  - 표준 체스 기물 메커니즘 유지(이동/캐슬링/앙파상/승급)
//  - 승리: 상대 '가이아(킹)'를 잡으면 종료(체크/체크메이트 개념 없음)
//  - 에너지바: 시작 10. 기물 이동 시 점수만큼 에너지 소모.
//  - 특수 필드(고정 배치): 광산·에너지(에너지 충전), 거래소(협상)
// ============================================================

export const START_ENERGY = 10;
// 기물 점수(이동 비용). 킹=가이아는 이동 1로 둠(교착 방지).
export const VALUE = { k: 1, q: 9, r: 5, b: 3, n: 3, p: 1 };
export const NAME_KO = {
  k: '가이아', q: '초대형 인프라', r: '화력 에너지', b: '풍력 에너지', n: '원자력 에너지', p: '전기 에너지',
};
export const GLYPH = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};

// 고정 특수 필드 (row 0 = 위쪽/흑 진영). 'E'=에너지, 'T'=거래소
export const FIELDS = (() => {
  const m = {};
  const set = (r, c, t) => { m[`${r},${c}`] = t; };
  [[3,3],[3,4],[4,3],[4,4],[2,2],[2,5],[5,2],[5,5]].forEach(([r,c]) => set(r,c,'E'));
  [[2,0],[2,7],[5,0],[5,7],[3,1],[4,6]].forEach(([r,c]) => set(r,c,'T'));
  return m;
})();
export function fieldAt(r, c) { return FIELDS[`${r},${c}`] || null; }

function startBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const back = ['r','n','b','q','k','b','n','r'];
  for (let c = 0; c < 8; c++) {
    b[0][c] = { t: back[c], color: 'b' };
    b[1][c] = { t: 'p', color: 'b' };
    b[6][c] = { t: 'p', color: 'w' };
    b[7][c] = { t: back[c], color: 'w' };
  }
  return b;
}

export function createInitialState(hostId, hostName) {
  return {
    game: 'chess',
    phase: 'wait',                 // wait → play → over
    hostId,
    seats: { w: hostId, b: null },
    names: { [hostId]: hostName },
    board: startBoard(),
    energy: { w: START_ENERGY, b: START_ENERGY },
    turn: 'w',
    castling: { wk: true, wq: true, bk: true, bq: true },
    enPassant: null,               // [r,c] 잡을 수 있는 칸
    pending: null,                 // 거래 제안
    winner: null,
    log: [`방 생성됨. 백(가이아 수호자) 준비 완료. 흑 플레이어를 기다립니다. (방장: ${hostName})`],
    moveCount: 0,
  };
}

function pushLog(s, m) { s.log.push(m); if (s.log.length > 80) s.log.shift(); }
function inB(r, c) { return r >= 0 && c >= 0 && r < 8 && c < 8; }

// ---------- 의사 합법 이동 생성 ----------
export function movesFrom(s, r, c) {
  const p = s.board[r][c];
  if (!p) return [];
  const out = [];
  const add = (rr, cc, meta = {}) => out.push({ from: [r, c], to: [rr, cc], ...meta });
  const enemy = opp(p.color);
  const slide = (dirs) => {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (inB(rr, cc)) {
        const q = s.board[rr][cc];
        if (!q) add(rr, cc);
        else { if (q.color === enemy) add(rr, cc, { cap: true }); break; }
        rr += dr; cc += dc;
      }
    }
  };
  const step = (deltas) => {
    for (const [dr, dc] of deltas) {
      const rr = r + dr, cc = c + dc;
      if (!inB(rr, cc)) continue;
      const q = s.board[rr][cc];
      if (!q) add(rr, cc);
      else if (q.color === enemy) add(rr, cc, { cap: true });
    }
  };

  if (p.t === 'r') slide([[1,0],[-1,0],[0,1],[0,-1]]);
  else if (p.t === 'b') slide([[1,1],[1,-1],[-1,1],[-1,-1]]);
  else if (p.t === 'q') slide([[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]);
  else if (p.t === 'n') step([[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]]);
  else if (p.t === 'k') {
    step([[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]);
    // 캐슬링
    const homeR = p.color === 'w' ? 7 : 0;
    if (r === homeR && c === 4) {
      const ks = p.color === 'w' ? s.castling.wk : s.castling.bk;
      const qs = p.color === 'w' ? s.castling.wq : s.castling.bq;
      if (ks && !s.board[homeR][5] && !s.board[homeR][6] && s.board[homeR][7]?.t === 'r')
        add(homeR, 6, { castle: 'k' });
      if (qs && !s.board[homeR][1] && !s.board[homeR][2] && !s.board[homeR][3] && s.board[homeR][0]?.t === 'r')
        add(homeR, 2, { castle: 'q' });
    }
  } else if (p.t === 'p') {
    const dir = p.color === 'w' ? -1 : 1;
    const startR = p.color === 'w' ? 6 : 1;
    const promoR = p.color === 'w' ? 0 : 7;
    // 전진
    if (inB(r + dir, c) && !s.board[r + dir][c]) {
      addPawn(out, r, c, r + dir, c, promoR);
      if (r === startR && !s.board[r + 2 * dir][c]) add(r + 2 * dir, c, { double: true });
    }
    // 캡처
    for (const dc of [-1, 1]) {
      const rr = r + dir, cc = c + dc;
      if (!inB(rr, cc)) continue;
      const q = s.board[rr][cc];
      if (q && q.color === enemy) addPawn(out, r, c, rr, cc, promoR, true);
      else if (s.enPassant && s.enPassant[0] === rr && s.enPassant[1] === cc)
        add(rr, cc, { cap: true, ep: true });
    }
  }
  return out;
}

function addPawn(out, r, c, rr, cc, promoR, cap = false) {
  if (rr === promoR) {
    for (const promo of ['q', 'r', 'b', 'n'])
      out.push({ from: [r, c], to: [rr, cc], cap, promo });
  } else {
    out.push({ from: [r, c], to: [rr, cc], cap });
  }
}

export function allMoves(s, color) {
  const list = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = s.board[r][c];
    if (p && p.color === color) list.push(...movesFrom(s, r, c));
  }
  return list;
}

// 에너지로 둘 수 있는 이동만
export function affordableMoves(s, color) {
  const e = s.energy[color];
  return allMoves(s, color).filter((m) => VALUE[s.board[m.from[0]][m.from[1]].t] <= e);
}

// ============================================================
//  applyAction
// ============================================================
export function applyAction(state, action, fromId) {
  const s = structuredClone(state);

  if (action.type === 'SIT') {
    if (!s.seats.b && action.playerId !== s.seats.w) {
      s.seats.b = action.playerId;
      s.names[action.playerId] = action.name || '흑';
      s.phase = 'play';
      pushLog(s, `흑(${action.name || '흑'}) 입장! 게임을 시작합니다. 백 선공.`);
    }
    return s;
  }

  if (action.type === 'RESPOND_TRADE') return resolveTrade(s, action);

  if (s.phase !== 'play') return s;
  const color = s.seats.w === action.playerId ? 'w' : s.seats.b === action.playerId ? 'b' : null;
  if (!color) return s;

  if (action.type === 'PROPOSE_TRADE') {
    // 거래소 위에 있을 때만(landed 플래그) — UI에서 보장하지만 서버도 확인
    if (!color) return s;
    s.pending = {
      from: color,
      offerEnergy: Math.max(0, action.offerEnergy | 0),
      wantEnergy: Math.max(0, action.wantEnergy | 0),
      offerPiece: action.offerPiece || null,  // [r,c]
      wantPiece: action.wantPiece || null,
    };
    pushLog(s, `💱 ${color === 'w' ? '백' : '흑'}이(가) 거래를 제안했습니다.`);
    return s;
  }

  if (action.type !== 'MOVE' && action.type !== 'PASS') return s;
  if (color !== s.turn) return s; // 턴 아님

  // MOVE
  const { from, to } = action;
  const piece = s.board[from[0]][from[1]];
  if (!piece || piece.color !== color) return s;
  const legal = movesFrom(s, from[0], from[1])
    .find((m) => m.to[0] === to[0] && m.to[1] === to[1] && (action.promo ? m.promo === action.promo : true));
  if (!legal) return s;
  const cost = VALUE[piece.t];
  if (s.energy[color] < cost) { pushLog(s, '에너지가 부족합니다.'); return s; }

  s.energy[color] -= cost;
  s.enPassant = null;

  // 캡처 처리
  let captured = s.board[to[0]][to[1]];
  if (legal.ep) {
    const dir = color === 'w' ? 1 : -1; // 잡히는 폰은 도착칸 뒤
    captured = s.board[to[0] + dir][to[1]];
    s.board[to[0] + dir][to[1]] = null;
  }

  // 이동
  s.board[to[0]][to[1]] = piece;
  s.board[from[0]][from[1]] = null;

  // 캐슬링 룩 이동
  if (legal.castle) {
    const homeR = color === 'w' ? 7 : 0;
    if (legal.castle === 'k') { s.board[homeR][5] = s.board[homeR][7]; s.board[homeR][7] = null; }
    else { s.board[homeR][3] = s.board[homeR][0]; s.board[homeR][0] = null; }
  }
  // 더블 푸시 → 앙파상 칸
  if (legal.double) s.enPassant = [(from[0] + to[0]) / 2, from[1]];
  // 승급
  if (legal.promo) s.board[to[0]][to[1]] = { t: legal.promo, color };

  // 캐슬링 권리 갱신
  if (piece.t === 'k') { if (color === 'w') { s.castling.wk = s.castling.wq = false; } else { s.castling.bk = s.castling.bq = false; } }
  if (piece.t === 'r') {
    if (from[0] === 7 && from[1] === 0) s.castling.wq = false;
    if (from[0] === 7 && from[1] === 7) s.castling.wk = false;
    if (from[0] === 0 && from[1] === 0) s.castling.bq = false;
    if (from[0] === 0 && from[1] === 7) s.castling.bk = false;
  }

  s.moveCount++;
  const fcoord = coord(from), tcoord = coord(to);
  pushLog(s, `${color === 'w' ? '백' : '흑'} ${NAME_KO[piece.t]} ${fcoord}→${tcoord} (에너지 -${cost}, 잔여 ${s.energy[color]})`);

  // 킹(가이아) 잡힘 → 종료
  if (captured && captured.t === 'k') {
    s.phase = 'over';
    s.winner = color;
    pushLog(s, `🏆 ${color === 'w' ? '백' : '흑'}이(가) 상대 가이아를 함락! 게임 종료.`);
    return s;
  }
  if (captured) pushLog(s, `  └ ${NAME_KO[captured.t]} 격파!`);

  // 특수 필드 효과
  const field = fieldAt(to[0], to[1]);
  if (field === 'E') {
    const gain = 2 + Math.floor(Math.random() * 5); // 2~6
    s.energy[color] += gain;
    pushLog(s, `⚡ 에너지 필드 도달! 자원 카드로 에너지 +${gain} (잔여 ${s.energy[color]})`);
  } else if (field === 'T') {
    pushLog(s, `💱 거래소 도달! 상대와 협상할 수 있습니다.`);
    s.justLandedTrade = color;
  } else {
    s.justLandedTrade = null;
  }
  if (field !== 'T') s.justLandedTrade = null;

  s.turn = opp(color);
  return s;
}

export function coord([r, c]) { return 'abcdefgh'[c] + (8 - r); }
export function opp(c) { return c === 'w' ? 'b' : 'w'; }

function resolveTrade(s, action) {
  if (!s.pending) return s;
  const p = s.pending;
  const responder = opp(p.from);
  if (s.seats[responder] !== action.playerId) return s;
  s.pending = null;
  if (!action.accept) { pushLog(s, '거래가 거절되었습니다.'); return s; }

  // 에너지 충분 확인
  if (s.energy[responder] < p.wantEnergy || s.energy[p.from] < p.offerEnergy) {
    pushLog(s, '에너지가 부족하여 거래가 무산되었습니다.');
    return s;
  }
  s.energy[p.from] -= p.offerEnergy; s.energy[responder] += p.offerEnergy;
  s.energy[responder] -= p.wantEnergy; s.energy[p.from] += p.wantEnergy;

  // 기물 이전(선택)
  const give = (pieceCoord, fromColor, toColor) => {
    if (!pieceCoord) return;
    const pc = s.board[pieceCoord[0]][pieceCoord[1]];
    if (pc && pc.color === fromColor && pc.t !== 'k') pc.color = toColor;
  };
  give(p.offerPiece, p.from, responder);
  give(p.wantPiece, responder, p.from);

  pushLog(s, `🤝 거래 성사! (에너지 ${p.from}:${p.offerEnergy}↔${responder}:${p.wantEnergy})`);
  return s;
}
