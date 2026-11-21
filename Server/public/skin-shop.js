import { CHARACTERS, SKINS } from './cosmetics.js';
import { drawAvatar } from './visuals.js';

const CAT_IDS = ['cat', 'tabby', 'tuxedo'];
const collection = [
  ...CAT_IDS.map(id => SKINS.find(skin => skin.id === id)),
  ...SKINS.filter(skin => !CAT_IDS.includes(skin.id)),
];

function drawPortrait(canvas, characterId, skinId) {
  const ctx = canvas.getContext('2d');
  const scale = Math.min(canvas.width / 76, canvas.height / 70);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height * 0.55);
  ctx.scale(scale, scale);
  drawAvatar(ctx, { characterId, skinId }, {
    reducedMotion: true,
    highContrast: canvas.ownerDocument.body.dataset.highContrast === 'true',
  });
  ctx.restore();
}

export function createSkinShop({ content, lobbyMenu, form }) {
  const doc = content.ownerDocument;
  const lobbyEntry = doc.createElement('button');
  lobbyEntry.type = 'button';
  lobbyEntry.className = 'shop-lobby-entry';
  lobbyEntry.dataset.screen = 'shop';
  lobbyEntry.innerHTML = `
    <span class="shop-lobby-copy"><strong>아이템샵</strong><small>고양이 스킨 3종</small></span>
    <span class="shop-lobby-cats" aria-hidden="true">${CAT_IDS.map(() => '<canvas width="144" height="144"></canvas>').join('')}</span>
    <span class="shop-lobby-arrow" aria-hidden="true">→</span>`;
  lobbyMenu.before(lobbyEntry);
  // The lobby advertises the trio. The shop itself models the player's current character.
  lobbyEntry.querySelectorAll('canvas').forEach((canvas, index) => drawPortrait(canvas, 'momo', CAT_IDS[index]));

  content.innerHTML = `
    <article class="shop-product" aria-labelledby="shop-name">
      <figure class="shop-stage">
        <div class="shop-awning" aria-hidden="true"></div>
        <div class="shop-floor" aria-hidden="true"></div>
        <i class="shop-paw shop-paw-one" aria-hidden="true"></i><i class="shop-paw shop-paw-two" aria-hidden="true"></i>
        <i class="shop-glint shop-glint-one" aria-hidden="true"></i><i class="shop-glint shop-glint-two" aria-hidden="true"></i>
        <div class="shop-podium" aria-hidden="true"></div>
        <canvas id="shop-preview" width="640" height="640" role="img"></canvas>
        <figcaption class="shop-caption"></figcaption>
      </figure>
      <div class="shop-details">
        <span class="shop-family"></span>
        <h2 id="shop-name"></h2>
        <p id="shop-description"></p>
        <dl class="shop-facts"><div><dt>착용 대상</dt><dd>모든 캐릭터</dd></div><div><dt>가격</dt><dd>무료</dd></div></dl>
        <button id="shop-equip" type="button"></button>
        <span class="sr-only" role="status" aria-atomic="true"></span>
      </div>
    </article>
    <section class="shop-collection" aria-labelledby="shop-collection-name">
      <div class="shop-collection-heading"><h2 id="shop-collection-name">스킨 컬렉션</h2><span>총 ${collection.length}종</span></div>
      <div class="shop-skins">
        ${collection.map(skin => `
          <button type="button" class="shop-skin" data-shop-skin="${skin.id}" aria-pressed="false" aria-controls="shop-preview shop-name">
            <span class="shop-thumbnail"><canvas width="184" height="144" aria-hidden="true"></canvas></span>
            <span class="shop-skin-name">${skin.label}</span><span class="shop-worn" hidden>장착 중</span>
          </button>`).join('')}
      </div>
    </section>
    <div id="shop-practice-items"></div>`;

  const practiceShortcut = doc.createElement('button');
  practiceShortcut.type = 'button';
  practiceShortcut.className = 'shell-back shop-practice-shortcut';
  practiceShortcut.setAttribute('aria-controls', 'shop-practice-items');
  practiceShortcut.innerHTML = '연습 아이템 <span aria-hidden="true">↓</span>';
  content.previousElementSibling.querySelector('.shell-back').before(practiceShortcut);

  const shelf = content.querySelector('.shop-skins');
  const choices = [...shelf.querySelectorAll('[data-shop-skin]')];
  const hero = content.querySelector('#shop-preview');
  const equip = content.querySelector('#shop-equip');
  const announcement = content.querySelector('[role="status"]');
  let previewId = CAT_IDS[0];

  function character() {
    return CHARACTERS.find(entry => entry.id === form.elements.characterId.value) || CHARACTERS[0];
  }

  function renderSelection() {
    const skin = collection.find(entry => entry.id === previewId);
    const model = character();
    const equippedId = form.elements.skinId.value;
    drawPortrait(hero, model.id, skin.id);
    hero.setAttribute('aria-label', `${model.label}의 ${skin.label} 착용 모습`);
    content.querySelector('.shop-caption').textContent = `${model.label} 착용 미리보기`;
    content.querySelector('.shop-family').textContent = skin.id === 'cat' ? '고양이 컬렉션 · 추천' : CAT_IDS.includes(skin.id) ? '고양이 컬렉션' : '캐릭터 스킨';
    content.querySelector('#shop-name').textContent = skin.label;
    content.querySelector('#shop-description').textContent = skin.description;
    equip.disabled = skin.id === equippedId;
    equip.textContent = equip.disabled ? '장착 중' : '장착하기';
    for (const button of choices) {
      const id = button.dataset.shopSkin;
      button.setAttribute('aria-pressed', String(id === previewId));
      button.dataset.equipped = String(id === equippedId);
      button.querySelector('.shop-worn').hidden = id !== equippedId;
    }
  }

  function selectSkin(event) {
    const button = event.target.closest('button[data-shop-skin]');
    if (!button) return;
    previewId = button.dataset.shopSkin;
    renderSelection();
    announcement.textContent = `${hero.getAttribute('aria-label')} 미리보기`;
  }

  function equipSkin() {
    const radio = form.querySelector(`input[name="skinId"][value="${previewId}"]`);
    if (!radio || radio.checked || radio.matches(':disabled')) return;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    renderSelection();
    announcement.textContent = `${character().label}에게 ${content.querySelector('#shop-name').textContent} 스킨을 장착했어요.`;
  }
  function showPracticeItems() {
    const section = content.querySelector('#shop-practice-items fieldset');
    if (!section) return;
    section.tabIndex = -1;
    section.focus({ preventScroll: true });
    content.scrollTop += section.getBoundingClientRect().top - content.getBoundingClientRect().top;
  }
  practiceShortcut.addEventListener('click', showPracticeItems);
  shelf.addEventListener('click', selectSkin);
  equip.addEventListener('click', equipSkin);

  function refreshAppearance() {
    const model = character();
    for (const button of choices) drawPortrait(button.querySelector('canvas'), model.id, button.dataset.shopSkin);
    renderSelection();
  }

  return {
    refreshAppearance,
    open() {
      previewId = CAT_IDS[0];
      announcement.textContent = '';
      refreshAppearance();
      content.scrollTop = 0;
    },
    destroy() {
      practiceShortcut.removeEventListener('click', showPracticeItems);
      shelf.removeEventListener('click', selectSkin);
      equip.removeEventListener('click', equipSkin);
    },
  };
}
