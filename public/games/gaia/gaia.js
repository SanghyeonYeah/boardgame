import { Net } from '/js/net.js';
import { renderLobby, renderPlayers, toast, logLine, shareCode } from '/js/ui.js';
import {
  createInitialState, applyAction, legalMovesFor, diplomacyTargets,
  FACTIONS, FACTION_KO, FACTION_COLOR, currentFaction, infraAnchor, MAX_INFRA_PER_FACTION, DIPLO_FEE, typeKo,
} from './engine.js';

const net = new Net('gaia');
let myFactionPick = null;
let selected = null;          // 선택한 기물 id
let lastLogLen = 0;
let diploOpen = false;

const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), pickScreen = $('pickScreen'), game = $('game');

// ---------- 로비 ----------
function showLobby() {
  renderLobby({
    mount: lobby,
    subtitle: '가이아는 2–4인 플레이입니다. 방을 만들고 코드를 공유하세요.',
    onCreate: async ({ name }) => {
      await net.createRoom(createInitialState(net.id, name), applyAction, name);
      net.pushState();
      enterRoom();
    },
    onJoin: async ({ code, name }) => {
      await net.joinRoom(code, name);
      enterRoom();
    },
  });
  const params = new URLSearchParams(location.search);
  if (params.get('room')) {
    const c = params.get('room').toUpperCase();
    const codeInput = lobby.querySelector('#lobbyCode');
    if (codeInput) codeInput.value = c;
  }
}

function enterRoom() {
  lobby.classList.add('hidden');
  startHostTimer();
}

net.onState = (s) => render(s);
net.onPlayers = () => { if (net.state) render(net.state); };

// ---------- 렌더 ----------
function render(s) {
  if (!s) return;
  if (s.phase === 'pick') { renderPick(s); }
  else { renderPlay(s); }
  flushLog(s);
}

function myFaction(s) { return FACTIONS.find((f) => s.seats[f] === net.id) || null; }

function renderPick(s) {
  pickScreen.classList.remove('hidden');
  game.classList.add('hidden');
  $('pickCode').textContent = net.code;

  const grid = $('pickGrid');
  grid.innerHTML = '';
  const descs = {
    North: '눈과 얼음의 땅. 화력 발전소가 풍부하나 재생에너지·자원이 적음.',
    South: '온화하고 바람 부는 땅. 재생에너지와 자원이 가장 많음.',
    East: '거대 시장. 외교관이 많아 거래·동맹에 강함.',
    West: '예측불가의 땅. 모든 이벤트 확률이 높지만 자원은 매우 희박.',
  };
  FACTIONS.forEach((f) => {
    const taken = s.seats[f];
    const mine = s.seats[f] === net.id;
    const btn = document.createElement('button');
    btn.className = 'pickbtn' + (taken && !mine ? ' taken' : '');
    btn.style.borderColor = FACTION_COLOR[f];
    btn.innerHTML = `<b style="color:${FACTION_COLOR[f]}">${FACTION_KO[f]}${mine ? ' ✓' : ''}</b>
      <small>${descs[f]}</small>
      <small>${taken ? `→ ${s.seatNames[taken] || '선택됨'}` : '비어 있음'}</small>`;
    btn.disabled = taken && !mine;
    btn.onclick = () => {
      myFactionPick = f;
      net.dispatch({ type: 'PICK', faction: f, playerId: net.id, name: net.name });
    };
    grid.appendChild(btn);
  });

  // 참여자
  const pl = Object.entries(s.seats).filter(([, v]) => v)
    .map(([f, id]) => ({ name: s.seatNames[id] || '플레이어', host: id === s.hostId, f }));
  renderPlayers($('pickPlayers'), pl, (p) => FACTION_COLOR[p.f]);

  // 시작 버튼(방장만)
  const startBtn = $('startBtn');
  const count = Object.values(s.seats).filter(Boolean).length;
  if (net.isHost) {
    startBtn.classList.remove('hidden');
    startBtn.disabled = count < 2;
    startBtn.onclick = () => net.dispatch({ type: 'START', playerId: net.id });
  } else startBtn.classList.add('hidden');
  $('pickHint').textContent = net.isHost
    ? `${count}명 선택됨. 2명 이상이면 시작할 수 있습니다.`
    : '방장이 게임을 시작하기를 기다리는 중…';
  $('copyCode2').onclick = () => shareCode(net.code);
}

function renderPlay(s) {
  pickScreen.classList.add('hidden');
  game.classList.remove('hidden');

  renderScores(s);
  renderBoard(s);
  renderTurnPanel(s);
  renderPending(s);
  renderOver(s);
}

function renderScores(s) {
  const bar = $('scorebar');
  bar.innerHTML = '';
  const cur = currentFaction(s);
  s.pickOrder.forEach((f) => {
    const fc = s.factions[f];
    const fossils = s.pieces.filter((p) => p.faction === f && p.type === 'fossil').length;
    const infra = s.infra.filter((g) => g.faction === f).length;
    const div = document.createElement('div');
    div.className = 'sc' + (f === cur && s.phase === 'play' ? ' turn' : '');
    div.style.borderColor = FACTION_COLOR[f];
    div.innerHTML = `<div class="nm" style="color:${FACTION_COLOR[f]}">${FACTION_KO[f]}${s.seats[f] === net.id ? ' (나)' : ''}</div>
      <div>💎 ${fc.score}자원 · 🛢️${fossils} · ⚡${infra}/${MAX_INFRA_PER_FACTION}</div>
      ${fc.allies?.length ? `<div class="muted">동맹: ${fc.allies.map((a) => FACTION_KO[a]).join(',')}</div>` : ''}`;
    bar.appendChild(div);
  });
}

function getViewOrder(faction) {
  const asc = Array.from({ length: 17 }, (_, i) => i);
  const desc = Array.from({ length: 17 }, (_, i) => 16 - i);
  // outer = 행(row), inner = 열(col), xy(outer,inner) → [boardX, boardY]
  switch (faction) {
    case 'South': return { outer: asc,  inner: asc,  xy: (o, i) => [i, o] };
    case 'North': return { outer: desc, inner: desc, xy: (o, i) => [i, o] };
    case 'East':  return { outer: asc,  inner: asc,  xy: (o, i) => [o, i] };
    case 'West':  return { outer: desc, inner: desc, xy: (o, i) => [o, i] };
    default:      return { outer: asc,  inner: asc,  xy: (o, i) => [i, o] };
  }
}

function renderBoard(s) {
  const board = $('gboard');
  board.innerHTML = '';
  const mine = myFaction(s);
  const isMyTurn = mine && currentFaction(s) === mine && s.phase === 'play';

  // 선택된 기물의 합법 이동
  let legal = [];
  let selPiece = null;
  if (selected != null) {
    selPiece = s.pieces.find((p) => p.id === selected);
    if (selPiece) legal = legalMovesFor(s, selPiece);
  }
  const legalMap = new Map(legal.map((m) => [`${m.tx},${m.ty}`, m]));

  const V = getViewOrder(mine);
  for (const outer of V.outer) {
    for (const inner of V.inner) {
      const [x, y] = V.xy(outer, inner);
      const cell = document.createElement('div');
      const region = y <= 3 ? 'north' : y >= 13 ? 'south' : x <= 3 ? 'west' : x >= 13 ? 'east' : '';
      cell.className = 'gcell' + (region ? ' ' + region : '');
      const g = s.infra.find((gg) => x >= gg.x && x < gg.x + 3 && y >= gg.y && y < gg.y + 3);
      if (g) {
        cell.classList.add('infra');
        if (x === g.x + 1 && y === g.y + 1) cell.textContent = '⚡';
        cell.style.boxShadow = `inset 0 0 0 1px ${FACTION_COLOR[g.faction]}55`;
      }
      // 자원
      if (s.resources.some((r) => r.x === x && r.y === y)) {
        const dot = document.createElement('span'); dot.className = 'res'; cell.appendChild(dot);
      }
      // 기물
      const p = s.pieces.find((pp) => pp.x === x && pp.y === y);
      if (p) {
        const el = document.createElement('span');
        el.className = 'pc';
        el.style.borderColor = FACTION_COLOR[p.faction];
        el.style.color = FACTION_COLOR[p.faction];
        el.textContent = p.type === 'fossil' ? '🛢️' : p.type === 'renew' ? '🌱' : '🤝';
        cell.appendChild(el);
        if (p.id === selected) cell.classList.add('sel');
      }
      // 합법 이동 표시
      const lm = legalMap.get(`${x},${y}`);
      if (lm) { cell.classList.add('legal'); if (lm.cap) cell.classList.add('cap'); }

      cell.onclick = () => onCellClick(s, x, y, isMyTurn);
      board.appendChild(cell);
    }
  }
}  // end renderBoard

function onCellClick(s, x, y, isMyTurn) {
  if (!isMyTurn) { toast('자신의 턴이 아닙니다.'); return; }
  const mine = myFaction(s);
  const p = s.pieces.find((pp) => pp.x === x && pp.y === y);

  // 선택된 기물이 있고, 클릭한 칸이 합법 이동이면 이동
  if (selected != null) {
    const selPiece = s.pieces.find((pp) => pp.id === selected);
    if (selPiece) {
      const legal = legalMovesFor(s, selPiece);
      if (legal.some((m) => m.tx === x && m.ty === y)) {
        net.dispatch({ type: 'MOVE', pieceId: selected, tx: x, ty: y, playerId: net.id });
        selected = null;
        return;
      }
    }
  }
  // 내 기물 선택/해제
  if (p && p.faction === mine) {
    selected = selected === p.id ? null : p.id;
    renderBoard(s);
  } else {
    selected = null;
    renderBoard(s);
  }
}

function renderTurnPanel(s) {
  const mine = myFaction(s);
  const cur = currentFaction(s);
  const isMyTurn = mine && cur === mine && s.phase === 'play';
  $('turnTitle').textContent = s.phase === 'over'
    ? '게임 종료'
    : isMyTurn ? '👉 내 턴입니다!' : `${FACTION_KO[cur]} 진영의 턴`;
  $('turnHint').textContent = isMyTurn
    ? '기물을 클릭 → 초록(이동)/빨강(공격) 칸을 클릭하세요.'
    : '상대의 턴을 기다리는 중…';

  const createBtn = $('createFossilBtn');
  createBtn.disabled = !isMyTurn || !mine || s.factions[mine].score < 2;
  createBtn.onclick = () => { net.dispatch({ type: 'CREATE_FOSSIL', playerId: net.id }); };

  // 외교 버튼
  const diploBtn = $('diploBtn');
  const targets = (isMyTurn && mine) ? diplomacyTargets(s, mine) : [];
  if (targets.length) {
    diploBtn.classList.remove('hidden');
    diploBtn.onclick = () => { diploOpen = !diploOpen; renderDiplo(s, targets); };
    if (diploOpen) renderDiplo(s, targets); else $('pendingBox').dataset.diplo = '';
  } else { diploBtn.classList.add('hidden'); diploOpen = false; }

  $('passBtn').disabled = !isMyTurn;
  $('passBtn').onclick = () => { selected = null; net.dispatch({ type: 'PASS', playerId: net.id }); };
}

// 자원 또는 기물을 선택하는 입력 위젯
function makeOfferWidget(prefix) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:4px 0 6px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;';

  const mkRadio = (val, label, checked) => {
    const id = `${prefix}_${val}`;
    const r = document.createElement('input');
    r.type = 'radio'; r.name = `${prefix}_ot`; r.value = val; r.id = id; r.checked = checked;
    const l = document.createElement('label');
    l.htmlFor = id; l.textContent = label; l.style.marginRight = '4px';
    return { r, l };
  };

  const { r: radRes, l: labRes } = mkRadio('resource', '자원', true);
  const { r: radPc, l: labPc } = mkRadio('piece', '기물', false);

  const secRes = document.createElement('span');
  const amtInput = document.createElement('input');
  amtInput.type = 'number'; amtInput.min = '0'; amtInput.value = '0'; amtInput.style.width = '70px';
  secRes.append(amtInput, ' 개');

  const secPc = document.createElement('span');
  secPc.style.display = 'none';
  const typeSelect = document.createElement('select');
  [['fossil', '🛢️ 화력발전소'], ['renew', '🌱 재생에너지'], ['diplo', '🤝 외교관']].forEach(([v, t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t; typeSelect.appendChild(o);
  });
  const cntInput = document.createElement('input');
  cntInput.type = 'number'; cntInput.min = '1'; cntInput.value = '1'; cntInput.style.width = '55px';
  secPc.append(typeSelect, ' ', cntInput, ' 개');

  const tog = () => { secRes.style.display = radPc.checked ? 'none' : ''; secPc.style.display = radPc.checked ? '' : 'none'; };
  radRes.onchange = tog; radPc.onchange = tog;

  wrap.append(radRes, labRes, radPc, labPc, secRes, secPc);
  wrap.getValue = () => radRes.checked
    ? { type: 'resource', amount: parseInt(amtInput.value) || 0 }
    : { type: 'piece', pieceType: typeSelect.value, pieceCount: parseInt(cntInput.value) || 1 };
  return wrap;
}

function renderDiplo(s, targets) {
  const box = $('pendingBox');
  const allowAlliance = Object.values(s.seats).filter(Boolean).length > 2;
  box.innerHTML = `<div class="banner info"><b>외교 제안</b> — 조건을 입력하고 제안 유형을 선택하세요.</div>`;
  targets.forEach((t) => {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '12px';

    const termsInput = document.createElement('input');
    termsInput.type = 'text';
    termsInput.maxLength = 200;
    termsInput.placeholder = `${FACTION_KO[t]}에게 제안할 조건 (선택)…`;
    termsInput.style.cssText = 'width:100%;margin-bottom:6px;';

    const btnRow = document.createElement('div');
    btnRow.className = 'row';
    const label = document.createElement('span');
    label.style.cssText = `min-width:60px;color:${FACTION_COLOR[t]};font-weight:700;`;
    label.textContent = FACTION_KO[t];

    const offerLabel = document.createElement('span');
    offerLabel.className = 'muted small';
    offerLabel.textContent = '내가 줄 것:';
    offerLabel.style.display = 'block';
    const offerWidget = makeOfferWidget(`offer_${t}`);
    wrap.insertBefore(offerLabel, btnRow);
    wrap.insertBefore(offerWidget, btnRow);

    const trade = document.createElement('button');
    trade.className = 'sm'; trade.textContent = '💱 거래';
    trade.onclick = () => {
      const offer = offerWidget.getValue();
      net.dispatch({ type: 'PROPOSE', toFaction: t, kind: 'trade',
        fromOfferType: offer.type,
        fromOfferAmount: offer.amount ?? 0,
        fromOfferPieceType: offer.pieceType,
        fromOfferPieceCount: offer.pieceCount,
        terms: termsInput.value, playerId: net.id });
      diploOpen = false; box.innerHTML = '';
    };

    const ally = document.createElement('button');
    ally.className = 'sm'; ally.textContent = '🕊️ 동맹';
    ally.disabled = !allowAlliance;
    ally.title = allowAlliance ? '' : '2인 플레이에서는 동맹 불가';
    ally.onclick = () => {
      net.dispatch({ type: 'PROPOSE', toFaction: t, kind: 'alliance', terms: termsInput.value, playerId: net.id });
      diploOpen = false; box.innerHTML = '';
    };

    btnRow.append(label, trade, ally);
    wrap.append(termsInput, btnRow);
    box.appendChild(wrap);
  });
}

function renderPending(s) {
  if (diploOpen) return;
  const mine = myFaction(s);
  const box = $('pendingBox');
  // 나에게 온 제안 (맞거래 입력 필요) + 내가 낸 제안 중 상대가 맞거래를 제안한 것 (확정 대기)
  const incoming = s.pending.filter((p) => p.to === mine);
  const awaitConfirm = s.pending.filter((p) => p.from === mine && p.status === 'need_confirm');
  if (!incoming.length && !awaitConfirm.length) { box.innerHTML = ''; return; }
  box.innerHTML = '';

  incoming.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'banner warn';
    if (p.kind === 'trade' && p.status === 'need_counter') {
      const fOffer = p.fromOffer;
      const fromDesc = fOffer.type === 'resource' ? `자원 ${fOffer.amount}개` : `${typeKo(fOffer.pieceType)} ${fOffer.pieceCount}개`;
      div.innerHTML = `<b style="color:${FACTION_COLOR[p.from]}">${FACTION_KO[p.from]}</b>의 거래 제안
        <br>상대가 제공: <b>${fromDesc}</b>
        ${p.terms ? `<div class="muted small" style="margin-top:4px">📋 조건: ${p.terms}</div>` : ''}`;
      const counterLabel = document.createElement('div');
      counterLabel.className = 'muted small';
      counterLabel.style.marginTop = '8px';
      counterLabel.textContent = '내가 줄 것:';
      const counterWidget = makeOfferWidget(`counter_${p.id}`);
      const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '6px';
      const yes = document.createElement('button'); yes.className = 'primary sm'; yes.textContent = '맞거래 제안';
      yes.onclick = () => {
        const offer = counterWidget.getValue();
        net.dispatch({ type: 'RESPOND', pendingId: p.id, accept: true,
          toOfferType: offer.type,
          toOfferAmount: offer.amount ?? 0,
          toOfferPieceType: offer.pieceType,
          toOfferPieceCount: offer.pieceCount,
          playerId: net.id });
      };
      const no = document.createElement('button'); no.className = 'sm'; no.textContent = '거절';
      no.onclick = () => net.dispatch({ type: 'RESPOND', pendingId: p.id, accept: false, playerId: net.id });
      row.append(yes, no);
      div.append(counterLabel, counterWidget, row);
    } else if (p.kind === 'alliance') {
      div.innerHTML = `<b style="color:${FACTION_COLOR[p.from]}">${FACTION_KO[p.from]}</b>의 동맹 제안
        ${p.terms ? `<div class="muted small" style="margin-top:4px">📋 조건: ${p.terms}</div>` : ''}
        <div class="muted small">수락 시 양측 자원 ${DIPLO_FEE} 차감</div>`;
      const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '8px';
      const yes = document.createElement('button'); yes.className = 'primary sm'; yes.textContent = '수락';
      yes.onclick = () => net.dispatch({ type: 'RESPOND', pendingId: p.id, accept: true, playerId: net.id });
      const no = document.createElement('button'); no.className = 'sm'; no.textContent = '거절';
      no.onclick = () => net.dispatch({ type: 'RESPOND', pendingId: p.id, accept: false, playerId: net.id });
      row.append(yes, no); div.appendChild(row);
    }
    box.appendChild(div);
  });

  awaitConfirm.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'banner info';
    const fOf = p.fromOffer, tOf = p.toOffer;
    const fDesc = fOf.type === 'resource' ? `자원 ${fOf.amount}개` : `${typeKo(fOf.pieceType)} ${fOf.pieceCount}개`;
    const tDesc = tOf.type === 'resource' ? `자원 ${tOf.amount}개` : `${typeKo(tOf.pieceType)} ${tOf.pieceCount}개`;
    div.innerHTML = `<b style="color:${FACTION_COLOR[p.to]}">${FACTION_KO[p.to]}</b>의 맞거래 도착
      <br>내가 줄: <b>${fDesc}</b> → 내가 받을: <b>${tDesc}</b>
      ${p.terms ? `<div class="muted small" style="margin-top:4px">📋 조건: ${p.terms}</div>` : ''}
      <div class="muted small">확정 시 외교비 자원 −${DIPLO_FEE} 양측</div>`;
    const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '8px';
    const yes = document.createElement('button'); yes.className = 'primary sm'; yes.textContent = '거래 확정';
    yes.onclick = () => net.dispatch({ type: 'RESPOND', pendingId: p.id, accept: true, playerId: net.id });
    const no = document.createElement('button'); no.className = 'sm'; no.textContent = '취소';
    no.onclick = () => net.dispatch({ type: 'RESPOND', pendingId: p.id, accept: false, playerId: net.id });
    row.append(yes, no); div.appendChild(row);
    box.appendChild(div);
  });
}

function renderOver(s) {
  const box = $('overBox');
  if (s.phase !== 'over') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const winTxt = s.winner ? `🏆 승리: <b style="color:${FACTION_COLOR[s.winner]}">${FACTION_KO[s.winner]}</b>` : '무승부';
  const ranking = s.pickOrder.slice().sort((a, b) => s.factions[b].score - s.factions[a].score)
    .map((f) => `${FACTION_KO[f]} ${s.factions[f].score}자원`).join(' · ');
  box.innerHTML = `<div class="panel" style="text-align:center"><h2>${winTxt}</h2><p class="muted">${ranking}</p>
    <button class="primary" onclick="location.reload()">새 게임</button></div>`;
}

function flushLog(s) {
  const logEl = $('log');
  if (!logEl) return;
  if (s.log.length < lastLogLen) lastLogLen = 0; // 리셋
  for (let i = lastLogLen; i < s.log.length; i++) logLine(logEl, s.log[i]);
  lastLogLen = s.log.length;
}

// ---------- 타이머 (호스트가 종료 트리거) ----------
function startHostTimer() {
  setInterval(() => {
    const s = net.state;
    if (!s) return;
    if (s.phase === 'play' && s.endsAt) {
      const remain = Math.max(0, s.endsAt - Date.now());
      const mm = String(Math.floor(remain / 60000)).padStart(2, '0');
      const ss = String(Math.floor((remain % 60000) / 1000)).padStart(2, '0');
      const t = $('timer'); if (t) t.textContent = `${mm}:${ss}`;
      if (net.isHost && remain <= 0) net.dispatch({ type: 'TICK', playerId: net.id });
    }
  }, 1000);
}

showLobby();
