import { PRACTICE_ITEMS } from './practice-items.js';
import { drawPickup } from './visuals.js';

function createPracticeOptions(mount, preferences) {
  const doc = mount.ownerDocument;
  const choices = doc.createElement('fieldset');
  choices.className = 'practice-shop';
  const legend = doc.createElement('legend');
  legend.textContent = 'AI 연습 아이템';
  const hint = doc.createElement('p');
  hint.textContent = '무료로 하나를 장착하세요. 아이템을 켠 혼자 AI 연습에서 라운드마다 지급돼요.';
  hint.id = 'shop-practice-help';
  choices.setAttribute('aria-describedby', hint.id);
  const grid = doc.createElement('div');
  grid.className = 'practice-shop-grid';
  for (const item of [...PRACTICE_ITEMS, { id: 'none', label: '장착 해제' }]) {
    const card = doc.createElement('label');
    const radio = doc.createElement('input');
    radio.type = 'radio';
    radio.name = 'practiceItemId';
    radio.value = item.id;
    radio.addEventListener('change', () => {
      if (radio.checked) preferences.update({ loadout: { practiceItemId: item.id } });
    });
    card.append(radio);
    if (item.description) {
      const artwork = doc.createElement('img');
      artwork.alt = '';
      artwork.width = artwork.height = 96;
      const symbol = doc.createElement('canvas');
      symbol.width = symbol.height = 96;
      symbol.setAttribute('aria-hidden', 'true');
      artwork.addEventListener('error', () => {
        artwork.hidden = true;
        symbol.hidden = false;
      });
      artwork.src = item.icon;
      card.append(artwork, symbol);
    } else {
      card.className = 'practice-shop-clear';
    }
    const name = doc.createElement('strong');
    name.textContent = item.label;
    card.append(name);
    if (item.description) {
      const detail = doc.createElement('small');
      detail.textContent = item.description;
      card.append(detail);
    }
    grid.append(card);
  }
  choices.append(legend, hint, grid);
  mount.replaceChildren(choices);
}

export function renderPracticeShop(mount, preferences) {
  if (!mount.firstElementChild) createPracticeOptions(mount, preferences);
  const prefs = preferences.value;
  for (const radio of mount.querySelectorAll('input[name="practiceItemId"]')) {
    radio.checked = radio.value === prefs.loadout.practiceItemId;
    const art = radio.parentElement.querySelector('canvas');
    if (!art) continue;
    const artwork = radio.parentElement.querySelector('img');
    const useSymbol = prefs.highContrast || prefs.itemStyle !== 'classic' || (artwork.complete && !artwork.naturalWidth);
    artwork.hidden = useSymbol;
    art.hidden = !useSymbol;
    const ctx = art.getContext('2d');
    ctx.clearRect(0, 0, art.width, art.height);
    ctx.save();
    ctx.translate(48, 47);
    ctx.scale(1.75, 1.75);
    drawPickup(ctx, { type: radio.value }, { style: prefs.itemStyle, highContrast: prefs.highContrast, reducedMotion: true });
    ctx.restore();
  }
}
