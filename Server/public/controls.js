export const DEFAULT_BINDINGS = Object.freeze({ up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', bomb: 'Space', dart: 'KeyF' });
export const ACTION_LABELS = Object.freeze({ up: '위', down: '아래', left: '왼쪽', right: '오른쪽', bomb: '물폭탄', dart: '다트' });
const ACTIONS = Object.keys(DEFAULT_BINDINGS);
const ARROWS = Object.freeze({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' });
const supported = code => typeof code === 'string' && /^(Key[A-Z]|Digit[0-9]|Space)$/.test(code);

export function keyLabel(code) {
  if (code === 'Space') return 'SPACE';
  if (supported(code)) return code.replace(/^(Key|Digit)/, '');
  return '';
}

export function validateBindings(bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return { valid: false, error: '조작 키 6개를 선택해 주세요.' };
  const used = new Set();
  for (const action of ACTIONS) {
    const code = bindings[action];
    if (!supported(code)) return { valid: false, error: `${ACTION_LABELS[action]} 키는 영문 A–Z, 숫자 0–9 또는 SPACE로 설정해 주세요.` };
    if (used.has(code)) return { valid: false, error: `${keyLabel(code)} 키가 중복되었어요. 행동마다 다른 키를 선택해 주세요.` };
    used.add(code);
  }
  return { valid: true, error: '' };
}

export function normalizeBindings(value) {
  const bindings = validateBindings(value).valid ? value : DEFAULT_BINDINGS;
  return Object.fromEntries(ACTIONS.map(action => [action, bindings[action]]));
}

export function actionForEvent(event, bindings = DEFAULT_BINDINGS) {
  if (!event || event.ctrlKey || event.altKey || event.metaKey) return null;
  const target = event.target;
  if (target && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName?.toUpperCase() ?? '') || target.isContentEditable ||
      target.closest?.('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"])'))) return null;
  if (Object.hasOwn(ARROWS, event.code)) return ARROWS[event.code];
  return ACTIONS.find(action => bindings[action] === event.code) ?? null;
}
