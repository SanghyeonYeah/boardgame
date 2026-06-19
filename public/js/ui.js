// 공용 UI 헬퍼: 토스트, 로비 패널, 플레이어 목록, 이벤트 로그

export function toast(msg, ms = 3200) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, ms - 300);
  setTimeout(() => el.remove(), ms);
}

// 로비(방 만들기 / 참여) 패널을 렌더링하고 콜백을 연결한다.
// opts: { mount, onCreate({name}), onJoin({code,name}), subtitle }
export function renderLobby(opts) {
  const { mount, onCreate, onJoin, subtitle = '' } = opts;
  mount.innerHTML = `
    <div class="panel">
      <h3>방 만들기</h3>
      <div class="col">
        <div>
          <label>닉네임</label>
          <input type="text" id="lobbyNameC" maxlength="12" placeholder="예: 플레이어1" />
        </div>
        <button class="primary" id="lobbyCreate">새 방 만들기</button>
      </div>
    </div>
    <div class="panel">
      <h3>방 참여하기</h3>
      <div class="col">
        <div>
          <label>닉네임</label>
          <input type="text" id="lobbyNameJ" maxlength="12" placeholder="예: 플레이어2" />
        </div>
        <div>
          <label>방 코드</label>
          <input type="text" id="lobbyCode" maxlength="4" placeholder="ABCD"
                 style="text-transform:uppercase; letter-spacing:4px; font-family:ui-monospace,monospace;" />
        </div>
        <button id="lobbyJoin">입장</button>
      </div>
    </div>
    ${subtitle ? `<p class="muted small">${subtitle}</p>` : ''}
  `;
  const nC = mount.querySelector('#lobbyNameC');
  const nJ = mount.querySelector('#lobbyNameJ');
  const code = mount.querySelector('#lobbyCode');
  mount.querySelector('#lobbyCreate').onclick = () =>
    onCreate({ name: (nC.value || '호스트').trim() });
  mount.querySelector('#lobbyJoin').onclick = () => {
    const c = (code.value || '').toUpperCase().trim();
    if (c.length !== 4) return toast('방 코드 4자리를 입력하세요.');
    onJoin({ code: c, name: (nJ.value || '게스트').trim() });
  };
  code.addEventListener('input', () => { code.value = code.value.toUpperCase(); });
}

export function renderPlayers(mount, players, colorFor) {
  mount.innerHTML = '';
  players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = colorFor ? colorFor(p) : '#4ade80';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name || '익명';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = p.host ? '방장' : '참여자';
    row.append(sw, nm, tag);
    mount.appendChild(row);
  });
}

export function logLine(mount, text) {
  const e = document.createElement('div');
  e.className = 'e';
  e.innerHTML = text;
  mount.appendChild(e);
  mount.scrollTop = mount.scrollHeight;
}

export function shareCode(code) {
  const url = `${location.origin}${location.pathname}?room=${code}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(
      () => toast('초대 링크를 복사했습니다!'),
      () => toast(`방 코드: ${code}`)
    );
  } else {
    toast(`방 코드: ${code}`);
  }
}
