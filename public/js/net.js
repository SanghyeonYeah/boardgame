// ============================================================
//  Net : 방 생성 / 참여 / 실시간 동기화 (호스트 권위 모델)
// ------------------------------------------------------------
//  - 방을 만든 사람이 "호스트"가 되어 게임 상태(state)를 계산한다.
//  - 참여자(게스트)는 액션만 호스트에게 보내고, 호스트가 만든
//    state 를 받아 화면을 그린다.
//  - 전송 계층은 Supabase Realtime Broadcast 를 쓰며, 설정이
//    없으면 같은 브라우저 안에서만 동작하는 BroadcastChannel 로
//    폴백한다(개발/테스트용).
//
//  사용법:
//    const net = new Net('gaia');
//    net.onState   = (state) => render(state);
//    net.onPlayers = (players) => renderPlayers(players);
//    net.onMessage = (msg) => toast(msg);            // 선택
//    const code = await net.createRoom(initialState, applyAction);
//    // 또는
//    await net.joinRoom(code, name);
//    net.dispatch({ type: 'MOVE', ... });            // 액션 전송
// ============================================================

import { SUPABASE_URL, SUPABASE_ANON_KEY, HAS_SUPABASE } from './supabase-config.js';

let _supabasePromise = null;
async function getSupabase() {
  if (!HAS_SUPABASE) return null;
  if (!_supabasePromise) {
    _supabasePromise = import('https://esm.sh/@supabase/supabase-js@2')
      .then(({ createClient }) =>
        createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          realtime: { params: { eventsPerSecond: 20 } },
        })
      );
  }
  return _supabasePromise;
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자 제외
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function clientId() {
  let id = sessionStorage.getItem('cid');
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('cid', id);
  }
  return id;
}

export class Net {
  constructor(game) {
    this.game = game;
    this.id = clientId();
    this.name = '';
    this.code = null;
    this.isHost = false;
    this.state = null;
    this.players = [];           // [{id, name, joinedAt, host}]
    this.applyAction = null;     // 호스트 전용 (state, action, fromId, net) => newState
    this.channel = null;
    this._sb = null;
    this._bc = null;             // BroadcastChannel 폴백
    this._joinedAt = Date.now();

    // 콜백
    this.onState = () => {};
    this.onPlayers = () => {};
    this.onMessage = () => {};
    this.onAction = null;        // 호스트가 액션 수신 시(선택 훅)
  }

  get mode() { return HAS_SUPABASE ? 'supabase' : 'local'; }

  // ---- 방 만들기(호스트) ----
  async createRoom(initialState, applyAction, name = '호스트') {
    this.isHost = true;
    this.name = name;
    this.applyAction = applyAction;
    this.state = initialState;
    this.code = randomCode();
    await this._connect();
    this._syncPlayersFromPresence();
    return this.code;
  }

  // ---- 방 참여(게스트) ----
  async joinRoom(code, name = '게스트') {
    this.isHost = false;
    this.name = name;
    this.code = code.toUpperCase().trim();
    await this._connect();
    // 호스트에게 상태 요청
    this._broadcast('hello', { id: this.id, name: this.name });
    return this.code;
  }

  channelName() { return `bg.${this.game}.${this.code}`; }

  async _connect() {
    if (this.mode === 'supabase') await this._connectSupabase();
    else this._connectLocal();
  }

  // ---------- Supabase ----------
  async _connectSupabase() {
    const sb = await getSupabase();
    this._sb = sb;
    const channel = sb.channel(this.channelName(), {
      config: {
        broadcast: { self: false },
        presence: { key: this.id },
      },
    });
    this.channel = channel;

    channel.on('broadcast', { event: 'msg' }, ({ payload }) => this._onWire(payload));

    channel.on('presence', { event: 'sync' }, () => {
      this._syncPlayersFromPresence();
      // 호스트는 누군가 들어오면 최신 상태를 뿌려준다.
      if (this.isHost) this._broadcast('state', { state: this.state });
    });

    await new Promise((resolve) => {
      channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({
            id: this.id, name: this.name, host: this.isHost, joinedAt: this._joinedAt,
          });
          resolve();
        }
      });
    });
  }

  _syncPlayersFromPresence() {
    if (!this.channel || this.mode !== 'supabase') return;
    const st = this.channel.presenceState();
    const list = [];
    for (const key in st) {
      const meta = st[key][0];
      list.push({ id: meta.id, name: meta.name, host: meta.host, joinedAt: meta.joinedAt });
    }
    list.sort((a, b) => a.joinedAt - b.joinedAt);
    this.players = list;
    this.onPlayers(list);
  }

  // ---------- 로컬 폴백 (같은 브라우저) ----------
  _connectLocal() {
    const bc = new BroadcastChannel(this.channelName());
    this._bc = bc;
    this.channel = { _local: true };
    bc.onmessage = (e) => {
      const { from, event, payload } = e.data;
      if (from === this.id) return;
      if (event === 'presence') { this._localPresence(payload); return; }
      this._onWire({ from, event, payload });
    };
    // 로컬 presence 흉내
    this._localPlayers = new Map();
    this._localPlayers.set(this.id, {
      id: this.id, name: this.name, host: this.isHost, joinedAt: this._joinedAt,
    });
    this._announce();
    this._localPresenceTimer = setInterval(() => this._announce(), 1500);
    setTimeout(() => this._refreshLocalPlayers(), 100);
  }

  _announce() {
    if (!this._bc) return;
    this._bc.postMessage({
      from: this.id, event: 'presence',
      payload: { id: this.id, name: this.name, host: this.isHost, joinedAt: this._joinedAt },
    });
  }

  _localPresence(p) {
    this._localPlayers.set(p.id, p);
    this._refreshLocalPlayers();
    if (this.isHost) this._broadcast('state', { state: this.state });
  }

  _refreshLocalPlayers() {
    // 오래된 항목 정리
    const list = [...this._localPlayers.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    this.players = list;
    this.onPlayers(list);
  }

  // ---------- 공통 송수신 ----------
  _broadcast(event, payload) {
    if (this.mode === 'supabase') {
      if (!this.channel) return;
      this.channel.send({ type: 'broadcast', event: 'msg', payload: { from: this.id, event, payload } });
    } else if (this._bc) {
      this._bc.postMessage({ from: this.id, event, payload });
    }
  }

  _onWire({ from, event, payload }) {
    if (event === 'hello') {
      if (this.isHost) this._broadcast('state', { state: this.state });
      return;
    }
    if (event === 'state') {
      // 게스트만 외부 상태를 받아들인다.
      if (!this.isHost) {
        this.state = payload.state;
        this.onState(this.state);
      }
      return;
    }
    if (event === 'action') {
      if (this.isHost) this._handleAction(payload.action, from);
      return;
    }
    if (event === 'msg') {
      this.onMessage(payload, from);
      return;
    }
  }

  _handleAction(action, fromId) {
    if (this.onAction) this.onAction(action, fromId);
    if (this.applyAction) {
      const next = this.applyAction(this.state, action, fromId, this);
      if (next !== undefined && next !== null) this.state = next;
    }
    this.onState(this.state);
    this._broadcast('state', { state: this.state });
  }

  // ---- 액션 보내기(호스트는 즉시 적용, 게스트는 호스트로 전송) ----
  dispatch(action) {
    if (this.isHost) {
      this._handleAction(action, this.id);
    } else {
      this._broadcast('action', { action });
    }
  }

  // ---- 호스트가 상태를 직접 갱신하고 전파 ----
  pushState(state) {
    if (!this.isHost) return;
    if (state !== undefined) this.state = state;
    this.onState(this.state);
    this._broadcast('state', { state: this.state });
  }

  // ---- 자유 메시지(채팅 등) ----
  message(payload) { this._broadcast('msg', payload); }

  leave() {
    try {
      if (this.mode === 'supabase' && this._sb && this.channel) this._sb.removeChannel(this.channel);
      if (this._bc) { clearInterval(this._localPresenceTimer); this._bc.close(); }
    } catch (e) { /* ignore */ }
  }
}

export { randomCode };
