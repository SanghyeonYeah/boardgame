import { Net } from '/js/net.js';
import { renderLobby, toast, logLine, shareCode } from '/js/ui.js';
import {
  createInitialState, applyAction, movesFrom,
  VALUE, NAME_KO, GLYPH, fieldAt, coord, opp,
} from './engine.js';

const net = new Net('chess');
let selected = null;     // [r,c]
let lastLogLen = 0;
const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), game = $('game');

function showLobby() {
  renderLobby({
    mount: lobby,
    subtitle: '에너지 변형 체스는 2인 전용입니다. 방을 만든 사람이 백(선공)입니다.',
    onCreate: async ({ name }) => {
      await net.createRoom(createInitialState(net.id, name), applyAction, name);
      net.pushState();
      enter();
    },
    onJoin: async ({ code, name }) => {
      await net.joinRoom(code, name);
      net.dispatch({ type: 'SIT', playerId: net.id, name });
      enter();
    },
  });
  const room = new URLSearchParams(location.search).get('room');
  if (room) { const i = lobby.querySelector('#lobbyCode'); if (i) i.value = room.toUpperCase(); }
}

function enter() { lobby.classList.add('hidden'); game.classList.remove('hidden'); }

net.onState = (s) => render(s);

function myColor(s) {
  if (s.seats.w === net.id) return 'w';
  if (s.seats.b === net.id) return 'b';
  return null;
}

function render(s) {
  if (!s) return;
  const mc = myColor(s);
  $('roomBanner').innerHTML = `방 코드 <b>${net.code}</b> · 당신은 <b>${mc === 'w' ? '백 (가이아 수호자)' : mc === 'b' ? '흑' : '관전자'}</b>
    ${s.phase === 'wait' ? ' · 상대를 기다리는 중…' : ''}
    <button class="sm ghost" id="copyc" style="margin-left:8px">코드 복사</button>`;
  $('copyc').onclick = () => shareCode(net.code);

  renderEnergy(s, mc);
  renderBoard(s, mc);
  renderTurn(s, mc);
  renderTrade(s, mc);
  renderOver(s);
  flushLog(s);
}

function renderEnergy(s, mc) {
  // 아래쪽 = 내 색(관전자는 백 아래)
  const bottom = mc === 'b' ? 'b' : 'w';
  const top = bottom === 'w' ? 'b' : 'w';
  const fill = (el, color) => {
    el.querySelector('.who').textContent = (color === 'w' ? '백' : '흑') + (color === mc ? ' (나)' : '');
    el.querySelector('.en').textContent = `⚡ ${s.energy[color]}`;
    el.querySelector('.ebar > div').style.width = Math.min(100, (s.energy[color] / 20) * 100) + '%';
    el.classList.toggle('turn', s.turn === color && s.phase === 'play');
  };
  fill($('epTop'), top);
  fill($('epBot'), bottom);
}

function renderBoard(s, mc) {
  const board = $('cboard');
  board.innerHTML = '';
  const flip = mc === 'b';
  const rows = flip ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const cols = flip ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];

  let legal = [];
  if (selected && mc) {
    const sp = s.board[selected[0]][selected[1]];
    if (sp && sp.color === mc && s.energy[mc] >= VALUE[sp.t])
      legal = movesFrom(s, selected[0], selected[1]);
  }
  const legalSet = new Map(legal.map((m) => [`${m.to[0]},${m.to[1]}`, m]));

  for (const r of rows) {
    for (const c of cols) {
      const sq = document.createElement('div');
      const dark = (r + c) % 2 === 1;
      sq.className = 'csq ' + (dark ? 'dark' : 'light');
      const f = fieldAt(r, c);
      if (f) sq.classList.add('field-' + f);
      const p = s.board[r][c];
      if (p) {
        const g = document.createElement('span');
        g.className = 'glyph ' + p.color;
        g.textContent = GLYPH[p.color][p.t];
        g.title = NAME_KO[p.t] + ` (이동 비용 ${VALUE[p.t]})`;
        sq.appendChild(g);
      }
      if (selected && selected[0] === r && selected[1] === c) sq.classList.add('sel');
      const lm = legalSet.get(`${r},${c}`);
      if (lm) sq.classList.add(lm.cap || lm.ep ? 'cap' : 'move');
      sq.onclick = () => onSq(s, r, c, mc);
      board.appendChild(sq);
    }
  }
}

function onSq(s, r, c, mc) {
  if (s.phase !== 'play') return;
  if (mc !== s.turn) { if (s.board[r][c]) toast('당신의 턴이 아닙니다.'); return; }
  const p = s.board[r][c];

  if (selected) {
    const moves = movesFrom(s, selected[0], selected[1]);
    const targets = moves.filter((m) => m.to[0] === r && m.to[1] === c);
    if (targets.length) {
      const piece = s.board[selected[0]][selected[1]];
      if (s.energy[mc] < VALUE[piece.t]) { toast('에너지가 부족합니다.'); return; }
      if (targets.some((m) => m.promo)) {
        askPromo((promo) => {
          net.dispatch({ type: 'MOVE', from: selected, to: [r, c], promo, playerId: net.id });
          selected = null;
        });
        return;
      }
      net.dispatch({ type: 'MOVE', from: selected, to: [r, c], playerId: net.id });
      selected = null;
      return;
    }
  }
  if (p && p.color === mc) { selected = (selected && selected[0] === r && selected[1] === c) ? null : [r, c]; renderBoard(s, mc); }
  else { selected = null; renderBoard(s, mc); }
}

function askPromo(cb) {
  const modal = $('promoModal'), row = $('promoRow');
  row.innerHTML = '';
  ['q', 'r', 'b', 'n'].forEach((t) => {
    const b = document.createElement('button');
    b.textContent = GLYPH.w[t];
    b.title = NAME_KO[t];
    b.onclick = () => { modal.classList.add('hidden'); cb(t); };
    row.appendChild(b);
  });
  modal.classList.remove('hidden');
}

function renderTurn(s, mc) {
  const t = $('turnTitle');
  if (s.phase === 'wait') { t.textContent = '상대 입장 대기 중…'; }
  else if (s.phase === 'over') { t.textContent = '게임 종료'; }
  else t.textContent = s.turn === mc ? '👉 당신의 턴' : `${s.turn === 'w' ? '백' : '흑'}의 턴`;
}

function pieceOptions(s, color) {
  let html = '<option value="">없음</option>';
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = s.board[r][c];
      if (p && p.color === color && p.t !== 'k')
        html += `<option value="${r},${c}">${NAME_KO[p.t]} (${coord([r, c])})</option>`;
    }
  return html;
}
function parsePiece(v) { return v ? v.split(',').map(Number) : null; }

function renderTrade(s, mc) {
  const box = $('tradeBox');
  box.innerHTML = '';

  // 받은 제안
  if (s.pending && s.pending.from !== mc && (s.seats.w === net.id || s.seats.b === net.id)) {
    const p = s.pending;
    const pieceLabel = (rc, color) => {
      if (!rc) return null;
      const pc = s.board[rc[0]][rc[1]];
      return pc ? `${NAME_KO[pc.t]} (${coord(rc)})` : '기물';
    };
    const div = document.createElement('div');
    div.className = 'banner warn';
    div.innerHTML = `<b>거래 제안</b><br>
      상대 제공: 에너지 ${p.offerEnergy}${p.offerPiece ? ` + ${pieceLabel(p.offerPiece, p.from)}` : ''}<br>
      상대 요구: 에너지 ${p.wantEnergy}${p.wantPiece ? ` + ${pieceLabel(p.wantPiece, opp(p.from))}` : ''}`;
    const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '8px';
    const y = document.createElement('button'); y.className = 'primary sm'; y.textContent = '수락';
    y.onclick = () => net.dispatch({ type: 'RESPOND_TRADE', accept: true, playerId: net.id });
    const n = document.createElement('button'); n.className = 'sm'; n.textContent = '거절';
    n.onclick = () => net.dispatch({ type: 'RESPOND_TRADE', accept: false, playerId: net.id });
    row.append(y, n); div.appendChild(row); box.appendChild(div);
    return;
  }

  // 거래소 도착 → 제안 작성
  if (s.justLandedTrade && s.justLandedTrade === mc && !s.pending) {
    const oppColor = opp(mc);
    const div = document.createElement('div');
    div.innerHTML = `
      <div class="banner info">💱 거래소 — 조건을 설정하고 제안하세요.</div>
      <label>내가 줄 에너지</label>
      <input type="number" id="offE" value="0" min="0" max="${s.energy[mc]}" />
      <label>내가 줄 기물 (선택)</label>
      <select id="offP">${pieceOptions(s, mc)}</select>
      <label>내가 받을 에너지</label>
      <input type="number" id="wantE" value="0" min="0" />
      <label>내가 받을 기물 (선택)</label>
      <select id="wantP">${pieceOptions(s, oppColor)}</select>`;
    const btn = document.createElement('button');
    btn.className = 'primary'; btn.style.marginTop = '8px'; btn.textContent = '제안 보내기';
    btn.onclick = () => {
      net.dispatch({
        type: 'PROPOSE_TRADE', playerId: net.id,
        offerEnergy: parseInt($('offE').value) || 0,
        wantEnergy: parseInt($('wantE').value) || 0,
        offerPiece: parsePiece($('offP').value),
        wantPiece: parsePiece($('wantP').value),
      });
    };
    div.appendChild(btn); box.appendChild(div);
  }
}

function renderOver(s) {
  const box = $('overBox');
  if (s.phase !== 'over') { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="panel" style="text-align:center;margin-top:16px">
    <h2>🏆 ${s.winner === 'w' ? '백' : '흑'} 승리!</h2>
    <p class="muted">상대 가이아를 함락했습니다.</p>
    <button class="primary" onclick="location.reload()">새 게임</button></div>`;
}

function flushLog(s) {
  const el = $('log'); if (!el) return;
  if (s.log.length < lastLogLen) lastLogLen = 0;
  for (let i = lastLogLen; i < s.log.length; i++) logLine(el, s.log[i]);
  lastLogLen = s.log.length;
}

showLobby();
