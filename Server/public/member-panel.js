/** Account forms and private record views. Never renders credentials into HTML. */
export function createMemberPanel({ document = globalThis.document, client, onSession = () => {}, onNavigate = () => {} }) {
  const login = document.getElementById('member-login-panel'), profile = document.getElementById('member-panel');
  let config = null, mode = 'login', busy = false, generation = 0;
  login.innerHTML = `<div class="member-card"><p class="shell-kicker">MY POP POP</p><h2 id="member-title">다시 만나서 반가워요</h2><p class="member-description">계정을 만들면 다른 기기에서도 내 전적과 등급을 이어갈 수 있어요.</p><div class="member-tabs" role="group" aria-label="회원 메뉴"><button type="button" id="member-login-tab" aria-pressed="true">로그인</button><button type="button" id="member-signup-tab" aria-pressed="false">회원가입</button></div><form id="member-form"><fieldset id="member-fields"><label id="member-name-label" hidden>닉네임<input id="member-name" maxlength="12" autocomplete="nickname" value="Popper"></label><label>이메일<input id="member-email" type="email" autocomplete="username" required maxlength="254" placeholder="you@example.com"></label><label>비밀번호<input id="member-password" type="password" minlength="8" maxlength="128" autocomplete="current-password" required placeholder="8자 이상"></label><button id="member-submit" class="button primary" type="submit">로그인</button></fieldset></form><p id="member-message" role="status" aria-live="polite"></p><p class="member-note">회원 서비스가 준비 중이어도 AI 연습과 훈련은 바로 즐길 수 있어요.</p><button id="member-back" class="button quiet" type="button">로비로 돌아가기</button></div>`;
  profile.innerHTML = `<div class="member-profile"><div class="member-heading"><div><p class="shell-kicker">PLAYER RECORD</p><h2>내 정보와 기록</h2><p id="member-identity"></p></div><button type="button" id="member-signout" class="button quiet">로그아웃</button></div><p id="member-profile-message" role="status" aria-live="polite"></p><div id="member-records" hidden><form id="profile-form"><label>닉네임<input id="profile-nickname" maxlength="12" required autocomplete="nickname"></label><button type="submit" class="button quiet">이름 저장</button></form><div id="member-stats" class="member-stat-grid"></div><section><h3>최근 경기</h3><p id="member-history-note"></p><div class="member-table-wrap"><table><thead><tr><th>날짜</th><th>대전</th><th>결과</th><th>점수</th></tr></thead><tbody id="member-history"></tbody></table></div></section><section><h3>결제 내역</h3><p>상품 결제는 아직 제공하지 않습니다. 결제 서비스 연결 후 이곳에서 내역을 확인할 수 있어요.</p><p id="member-payment-note"></p><div class="member-table-wrap"><table><thead><tr><th>날짜</th><th>상품</th><th>금액</th><th>상태</th></tr></thead><tbody id="member-payments"></tbody></table></div></section></div><button type="button" id="member-retry" class="button quiet">다시 불러오기</button></div>`;
  const $ = id => document.getElementById(id);
  const configured = () => Boolean(config?.supabaseUrl && config?.supabaseAnonKey);
  const message = (id,text,error=false) => { $(id).textContent=text; $(id).classList.toggle('error',error); };
  function setBusy(value) { busy=value; $('member-fields').disabled=value || !configured(); $('member-signout').disabled=value; }
  function setMode(value) {
    if (busy) return;
    mode=value==='signup'?'signup':'login';
    $('member-name-label').hidden=mode!=='signup';
    $('member-title').textContent=mode==='signup'?'나만의 플레이어를 만들어요':'다시 만나서 반가워요';
    $('member-submit').textContent=mode==='signup'?'회원가입':'로그인';
    $('member-password').autocomplete=mode==='signup'?'new-password':'current-password';
    $('member-password').minLength=mode==='signup'?8:1;
    $('member-login-tab').setAttribute('aria-pressed',String(mode==='login'));
    $('member-signup-tab').setAttribute('aria-pressed',String(mode==='signup'));
    message('member-message',configured()?'':'회원 서비스를 준비 중입니다. 로비에서 AI 연습을 시작해 주세요.');
  }
  function rows(id, values, cells) {
    const fragment=document.createDocumentFragment();
    for(const value of values || []) {
      const tr=document.createElement('tr');
      for(const text of cells(value)) { const td=document.createElement('td');td.textContent=String(text ?? '—');tr.append(td); }
      fragment.append(tr);
    }
    $(id).replaceChildren(fragment);
  }
  function date(value) { const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleDateString('ko-KR'); }
  function money(value) {
    try { const format=new Intl.NumberFormat('ko-KR',{style:'currency',currency:value.currency});return format.format(value.amountMinor/10**format.resolvedOptions().maximumFractionDigits); }
    catch { return `${value.amountMinor} ${value.currency || ''}`; }
  }
  function records(data) {
    const p=data.profile || {}, stats=data.stats || {};
    $('member-records').hidden=false;
    $('member-identity').textContent=data.user?.email || '';
    $('profile-nickname').value=p.nickname || '';
    const tier=Number(p.rating)>=1450?'Diamond':Number(p.rating)>=1250?'Gold':Number(p.rating)>=1100?'Silver':'Bronze';
    $('member-stats').replaceChildren(...[
      ['등급',`${tier} · ${p.rating ?? '—'}`],['순위',stats.rank==null?'집계 대기':`${stats.rank}위`],['전적',`${p.wins || 0}승 ${p.losses || 0}패 ${p.draws || 0}무`],['누적 점수',Number(p.score || 0).toLocaleString('ko-KR')]
    ].map(([name,value])=>{const item=document.createElement('div'),label=document.createElement('span'),strong=document.createElement('strong');label.textContent=name;strong.textContent=value;item.append(label,strong);return item;}));
    message('member-history-note',data.historyStatus==='unavailable'?'경기 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.':data.recentMatches?.length?'최근 완료한 경기입니다.':'아직 저장된 경기 기록이 없습니다.');
    rows('member-history',data.recentMatches,p=>[date(p.playedAt),p.mode==='team'?'4 vs 4':'1 vs 1',({win:'승리',loss:'패배',draw:'무승부'})[p.outcome] || '종료',p.score]);
    message('member-payment-note',data.paymentStatus==='unavailable'?'결제 내역을 불러올 수 없습니다.':data.payments?.length?'본인 계정의 결제 기록입니다.':'결제 내역이 없습니다.');
    rows('member-payments',data.payments,p=>[date(p.createdAt),p.description,money(p),({paid:'완료',pending:'처리 중',failed:'실패',refunded:'환불',cancelled:'취소'})[p.status] || p.status]);
    onSession(client.getSession(),p);
  }
  async function load() {
    const ticket=++generation;
    $('member-records').hidden=true;
    if (!client.getSession()) { onSession(null); message('member-profile-message','로그인하면 내 전적과 회원정보를 볼 수 있어요.');onNavigate('login');return false; }
    message('member-profile-message','내 기록을 불러오는 중…');
    try { const data=await client.getAccount();if(ticket!==generation)return false;records(data);message('member-profile-message','');return true; }
    catch(error) { if(ticket===generation){onSession(client.getSession());message('member-profile-message',error.message || '회원정보를 불러오지 못했습니다.',true);}return false; }
  }
  $('member-login-tab').addEventListener('click',()=>setMode('login'));
  $('member-signup-tab').addEventListener('click',()=>setMode('signup'));
  $('member-back').addEventListener('click',()=>{generation++;onNavigate('lobby');});
  $('member-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy || !configured())return;
    const ticket=++generation, email=$('member-email').value.trim(), password=$('member-password').value, nickname=$('member-name').value.trim();
    setBusy(true);message('member-message',mode==='signup'?'회원가입 중…':'로그인 중…');
    try {
      const result=mode==='signup'?await client.signUp(email,password,nickname):{session:await client.signIn(email,password)};
      $('member-password').value='';
      onSession(client.getSession());
      if(ticket!==generation)return;
      if(result.confirmationRequired) { message('member-message','가입 확인 메일을 보냈습니다. 이메일에서 확인한 뒤 로그인해 주세요.');setBusy(false);setMode('login');message('member-message','가입 확인 메일을 보냈습니다. 이메일에서 확인한 뒤 로그인해 주세요.');return; }
      onSession(client.getSession());message('member-message','로그인했습니다.');onNavigate('profile');await load();
    } catch(error) { if(ticket===generation)message('member-message',error.message || '로그인하지 못했습니다.',true); }
    finally { setBusy(false); }
  });
  $('member-signout').addEventListener('click',async()=>{
    if(busy)return;const ticket=++generation;setBusy(true);
    $('member-records').hidden=true;$('member-identity').textContent='';$('member-history').replaceChildren();$('member-payments').replaceChildren();
    try { const pending=client.signOut();onSession(client.getSession());await pending; }
    catch { /* Local session is cleared even when remote revocation is unavailable. */ }
    finally { setBusy(false);if(ticket===generation)onNavigate('lobby'); }
  });
  $('profile-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    const ticket=++generation;setBusy(true);message('member-profile-message','이름을 저장하는 중…');
    try { await client.updateProfile({nickname:$('profile-nickname').value.trim()});if(ticket===generation) {if(await load())message('member-profile-message','닉네임을 저장했습니다.');} }
    catch(error) { if(ticket===generation)message('member-profile-message',error.message || '이름을 저장하지 못했습니다.',true); }
    finally {setBusy(false);}
  });
  $('member-retry').addEventListener('click',()=>void load());
  setBusy(false);setMode('login');
  return {
    configure(value) {config=value;client.configure(value);setBusy(busy);setMode(mode);},
    open(view='login') {generation++;if(view==='profile')void load();else setMode(view==='signup'?'signup':'login');},
    invalidate() {generation++;},
    refresh:load
  };
}
