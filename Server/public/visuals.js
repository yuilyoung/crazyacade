import { CHARACTERS, SKINS, ORB_SKINS, ITEM_STYLES } from './cosmetics.js';

// Original Canvas2D vector artwork. All positions are local to a 60px cell;
// translation, team markers and gameplay overlays belong to the arena view.
const TAU = Math.PI * 2;
const INK = '#203f50';
const ids = values => new Set(values.map(value => value.id));
const characters = ids(CHARACTERS), skins = ids(SKINS), orbs = ids(ORB_SKINS), styles = ids(ITEM_STYLES);
const palettes = {
  classic: { main: '#6bbaca', dark: '#367e97', light: '#e7f4da', accent: '#f2bf55' },
  sunset: { main: '#ee886e', dark: '#b85263', light: '#ffe8b3', accent: '#ffd36c' },
  mint: { main: '#83c8a0', dark: '#347c69', light: '#eff5d3', accent: '#f6dc81' },
  astronaut: { main: '#eff4f2', dark: '#50738d', light: '#d5edf3', accent: '#ff9d68' },
  bee: { main: '#f9d66d', dark: '#514748', light: '#fff0bf', accent: '#eeb454' },
  raincoat: { main: '#f1c64e', dark: '#397b96', light: '#fff0aa', accent: '#ec9469' },
};

function shape(ctx, fill, stroke = INK, width = 1.8) {
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
}
function oval(ctx, x, y, rx, ry, fill, stroke = INK, width = 1.8, rotation = 0) {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rotation, 0, TAU); shape(ctx, fill, stroke, width);
}
function box(ctx, x, y, w, h, r, fill, stroke = INK, width = 1.8) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath(); shape(ctx, fill, stroke, width);
}
function poly(ctx, points, fill, stroke = INK, width = 1.8) {
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath(); shape(ctx, fill, stroke, width);
}
function line(ctx, points, color = INK, width = 1.8) {
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
}
function star(ctx, x, y, radius, fill, stroke = INK, width = 1.8) {
  const points = Array.from({ length: 10 }, (_, i) => {
    const angle = i * Math.PI / 5 - Math.PI / 2, r = i % 2 ? radius * .48 : radius;
    return [x + Math.cos(angle) * r, y + Math.sin(angle) * r];
  });
  poly(ctx, points, fill, stroke, width);
}
function leaf(ctx, x, y, size, color, rotation = -.5) {
  oval(ctx, x, y, size * .45, size, color, INK, 1.2, rotation);
  line(ctx, [[x - size * .2, y + size * .6], [x + size * .2, y - size * .6]], INK, 1);
}

function head(ctx, character, color, outline) {
  if (character === 'bibi') {
    oval(ctx, -9, -22, 4.6, 9, color, INK, outline, -.15);
    oval(ctx, 9, -22, 4.6, 9, color, INK, outline, .15);
    oval(ctx, -9, -23, 1.6, 5, '#e8a19a', null);
    oval(ctx, 9, -23, 1.6, 5, '#e8a19a', null);
    box(ctx, -15, -17, 30, 27, 12, color, INK, outline);
  } else if (character === 'nori') {
    oval(ctx, 0, -5, 20, 13, color, INK, outline);
    oval(ctx, 0, -17, 24, 6, color, INK, outline);
    oval(ctx, 0, -22, 12, 7, color, INK, outline);
  } else if (character === 'toto') {
    box(ctx, -18, -19, 36, 30, 7, color, INK, outline);
    box(ctx, -21, -23, 42, 8, 3, color, INK, outline);
    line(ctx, [[-14, -19], [-7, -19]], '#ffffffa0', 2);
  } else {
    oval(ctx, 0, -5, 16, 16, color, INK, outline);
    oval(ctx, 0, -22, 9, 8, color, INK, outline);
    oval(ctx, -3, -24, 2.4, 3, '#ffffffaa', null, 1, .3);
  }
}

/** Draw only cosmetic appearance; the caller owns team and gameplay indicators. */
export function drawAvatar(ctx, player = {}, { time = 0, reducedMotion = false, highContrast = false } = {}) {
  const character = characters.has(player.characterId) ? player.characterId : 'momo';
  const skin = skins.has(player.skinId) ? player.skinId : 'classic';
  const p = palettes[skin], outline = highContrast ? 2.7 : 1.8;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  oval(ctx, 0, 24, 20, 4, '#24475525', null);
  if (!reducedMotion && Number.isFinite(time)) ctx.translate(0, Math.sin(time / 500) * .65);

  // Accessories extend the silhouette, while each creature keeps its own head.
  if (skin === 'astronaut') {
    box(ctx, -24, -3, 12, 23, 5, p.dark, INK, outline);
    box(ctx, 12, -3, 12, 23, 5, p.dark, INK, outline);
    line(ctx, [[-20, 2], [-25, 8], [-20, 14]], p.accent, 3);
  } else if (skin === 'bee') {
    oval(ctx, -20, 2, 7, 13, '#e1f8f3', INK, outline, -.5);
    oval(ctx, 20, 2, 7, 13, '#e1f8f3', INK, outline, .5);
    line(ctx, [[-22, -4], [-17, 7]], '#8bbac7', 1);
    line(ctx, [[22, -4], [17, 7]], '#8bbac7', 1);
  } else if (skin === 'raincoat') {
    poly(ctx, [[-12, -5], [12, -5], [25, 19], [13, 23], [-13, 23], [-25, 19]], p.main, INK, outline);
  }

  // Feet and hands stay legible against every arena floor.
  box(ctx, -16, 17, 13, 8, 4, p.dark, INK, outline);
  box(ctx, 3, 17, 13, 8, 4, p.dark, INK, outline);
  if (skin === 'raincoat') {
    box(ctx, -15, 13, 11, 10, 2, p.dark, INK, outline);
    box(ctx, 4, 13, 11, 10, 2, p.dark, INK, outline);
  }
  oval(ctx, -17, 8, 4.5, 6, p.main, INK, outline, .3);
  oval(ctx, 17, 8, 4.5, 6, p.main, INK, outline, -.3);
  box(ctx, -14, 1, 28, 21, character === 'toto' ? 5 : 10, p.main, INK, outline);

  if (skin === 'sunset') {
    poly(ctx, [[0, -1], [21, 13], [10, 21], [0, 18], [-10, 21], [-21, 13]], p.main, INK, outline);
    line(ctx, [[-13, 10], [0, 16], [13, 10]], p.light, 3.8);
    line(ctx, [[-8, 5], [0, 9], [8, 5]], p.dark, 2.5);
    oval(ctx, 0, 15, 3, 2.5, p.accent, INK, 1);
  } else if (skin === 'mint') {
    box(ctx, -10, 2, 20, 18, 3, p.light, INK, 1.3);
    line(ctx, [[-7, 2], [-9, -2]], p.dark, 2);
    line(ctx, [[7, 2], [9, -2]], p.dark, 2);
    box(ctx, -6, 11, 12, 6, 2, p.main, INK, 1);
    leaf(ctx, 0, 7, 3.3, p.dark);
  } else if (skin === 'astronaut') {
    box(ctx, -9, 6, 18, 10, 2, p.dark, INK, 1.2);
    oval(ctx, -4, 10, 2, 2, p.accent, null);
    line(ctx, [[1, 9], [5, 9]], p.light, 1.5);
    line(ctx, [[1, 13], [5, 13]], p.light, 1.5);
    box(ctx, -13, 18, 26, 4, 1, p.dark, null);
  } else if (skin === 'bee') {
    line(ctx, [[-11, 8], [11, 8]], p.dark, 4.5);
    line(ctx, [[-10, 16], [10, 16]], p.dark, 4.5);
  } else if (skin === 'raincoat') {
    line(ctx, [[0, 1], [0, 21]], p.dark, 1.5);
    [8, 14, 20].forEach(y => oval(ctx, 3, y, 1, 1, p.dark, null));
    box(ctx, -11, 11, 6, 5, 1, p.light, INK, 1);
    box(ctx, 6, 11, 6, 5, 1, p.light, INK, 1);
  } else {
    poly(ctx, [[-10, 1], [10, 1], [6, 8], [0, 6], [-6, 8]], p.accent, INK, 1.2);
    line(ctx, [[-8, 10], [-8, 18]], p.dark, 1.5);
    line(ctx, [[8, 10], [8, 18]], p.dark, 1.5);
    star(ctx, 5, 13, 3.5, p.accent, INK, .9);
  }

  if (skin === 'raincoat') {
    // A hood follows the head contour instead of hiding ears and cap geometry.
    oval(ctx, 0, -8, character === 'nori' ? 24 : 21, 20, p.main, INK, outline);
  }
  head(ctx, character, p.light, outline);

  if (skin === 'sunset') {
    oval(ctx, 0, -16, character === 'nori' ? 25 : 19, 3.7, p.accent, INK, 1.4);
    box(ctx, -9, -22, 18, 6, 3, p.main, INK, 1.3);
    line(ctx, [[-6, -19], [6, -19]], p.dark, 1.5);
  } else if (skin === 'mint') {
    leaf(ctx, 7, -23, 6, p.main, .6);
    leaf(ctx, -1, -25, 5, p.dark, -.8);
    // A real watering can with handle and spout, carried beside the apron.
    oval(ctx, 20, 10, 5, 5, null, p.dark, 2);
    box(ctx, 13, 9, 10, 10, 2, p.main, INK, 1.3);
    poly(ctx, [[23, 12], [28, 9], [28, 13], [23, 16]], p.main, INK, 1.2);
  } else if (skin === 'bee') {
    line(ctx, [[-8, -19], [-14, -27]], p.dark, 2);
    line(ctx, [[8, -19], [14, -27]], p.dark, 2);
    oval(ctx, -14, -27, 2.8, 2.8, p.main, INK, 1.2);
    oval(ctx, 14, -27, 2.8, 2.8, p.main, INK, 1.2);
  } else if (skin === 'raincoat') {
    poly(ctx, [[-17, -9], [-6, -13], [6, -13], [17, -9], [11, -5], [-11, -5]], p.main, INK, 1.3);
    line(ctx, [[-12, -3], [-12, 3]], p.dark, 1);
    line(ctx, [[12, -3], [12, 3]], p.dark, 1);
  }

  // Shared face ensures every costume keeps character expression readable.
  oval(ctx, 0, -1, character === 'nori' ? 14 : 12, 8, '#fff7e4', null);
  oval(ctx, -5, -3, 1.8, 2.3, INK, null);
  oval(ctx, 5, -3, 1.8, 2.3, INK, null);
  oval(ctx, -9, 1, 2.3, 1.2, '#edb0a2', null);
  oval(ctx, 9, 1, 2.3, 1.2, '#edb0a2', null);
  line(ctx, [[-2, 2], [0, 3.5], [2, 2]], INK, 1.3);

  if (skin === 'astronaut') {
    // Transparent visor overlays the intact, recognizable creature silhouette.
    oval(ctx, 0, -7, character === 'nori' ? 26 : 23, 23, '#b1e8f21c', p.dark, outline + .6);
    ctx.beginPath(); ctx.ellipse(0, -7, character === 'nori' ? 22 : 19, 19, 0, 3.7, 4.6);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.stroke();
    box(ctx, -15, 9, 30, 5, 2, p.dark, INK, 1.2);
  }
  if (player.pin) star(ctx, 19, -13, 5.5, '#ffe897', INK, 1.4);
  ctx.restore();
}

/** All orb variants use identical visual footprint and show the same fuse cap. */
export function drawOrb(ctx, orb = {}, { time = 0, reducedMotion = false, highContrast = false } = {}) {
  const skin = orbs.has(orb.orbSkinId) ? orb.orbSkinId : 'bubble';
  const pulse = reducedMotion || !Number.isFinite(time) ? 0 : Math.sin(time / 170) * .6;
  const outline = highContrast ? 2.8 : 1.8;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  oval(ctx, 0, 19, 20, 5, '#24475525', null);
  ctx.translate(0, pulse);
  if (skin === 'star') {
    star(ctx, 0, 1, 22, '#b4e9f0', INK, outline);
    star(ctx, 0, 1, 14, '#fff0a8', '#689aa5', 1.2);
    oval(ctx, -4, -3, 2, 3, '#ffffff', null, 1, .5);
  } else if (skin === 'duck') {
    oval(ctx, 0, 6, 18, 13, '#ffe3a0', INK, outline);
    oval(ctx, -4, -6, 12, 12, '#ffe9ac', INK, outline);
    poly(ctx, [[5, -8], [20, -4], [18, 1], [5, 1]], '#f3a263', INK, outline);
    oval(ctx, -1, -9, 1.8, 2.2, INK, null);
    oval(ctx, -2, 9, 9, 5, '#f5c96f', '#ad8047', 1.2, -.2);
    line(ctx, [[-17, 8], [-23, 2], [-19, 13]], INK, outline);
    oval(ctx, -9, -12, 3, 2, '#ffffffaa', null);
  } else {
    const gradient = ctx.createRadialGradient(-7, -8, 1, 0, 0, 20);
    gradient.addColorStop(0, '#f3ffff'); gradient.addColorStop(.4, '#a4ebf2'); gradient.addColorStop(1, '#4ebbd4');
    oval(ctx, 0, 1, 19, 19, gradient, highContrast ? INK : '#26768e', outline);
    oval(ctx, -7, -8, 4, 6, '#ffffffb0', null, 1, .5);
    line(ctx, [[6, 12], [11, 8]], '#d7fbff', 2);
  }
  // The same mint valve identifies every variant as a placed water orb.
  box(ctx, -4, -23, 8, 7, 2, '#7ee1c6', INK, outline);
  line(ctx, [[-1, -21], [1, -21]], '#ffffff', 1.3);
  if (Number.isFinite(orb.fuse) && orb.fuse <= 8) {
    line(ctx, [[-24, -13], [-27, -17]], INK, outline);
    line(ctx, [[24, -13], [27, -17]], INK, outline);
  }
  ctx.restore();
}

const pickupColors = { orb: '#80d6c3', wave: '#f3cd6f', dash: '#9abcf1', speed: '#9abcf1', pin: '#efaec5', dart: '#f0bb87' };

function pickupSymbol(ctx, type, ink) {
  // Deliberately identical geometric symbols across themes; no font fallback.
  if (type === 'orb') {
    line(ctx, [[-6, 0], [6, 0]], ink, 3);
    line(ctx, [[0, -6], [0, 6]], ink, 3);
  } else if (type === 'wave') {
    line(ctx, [[-9, 0], [9, 0]], ink, 2.5);
    line(ctx, [[-5, -4], [-9, 0], [-5, 4]], ink, 2.5);
    line(ctx, [[5, -4], [9, 0], [5, 4]], ink, 2.5);
  } else if (type === 'dash' || type === 'speed') {
    line(ctx, [[-8, -6], [-2, 0], [-8, 6]], ink, 2.7);
    line(ctx, [[1, -6], [7, 0], [1, 6]], ink, 2.7);
  } else if (type === 'pin') {
    poly(ctx, [[0, -9], [2.5, -2.5], [8, 0], [2.5, 2.5], [0, 9], [-2.5, 2.5], [-8, 0], [-2.5, -2.5]], null, ink, 2);
  } else if (type === 'dart') {
    line(ctx, [[-7, 7], [7, -7], [0, -7]], ink, 2.7);
    line(ctx, [[7, -7], [7, 0]], ink, 2.7);
    line(ctx, [[-7, 3], [-3, 7]], ink, 2);
  } else {
    // Unknown server item: an explicit question mark, never a misleading buff.
    ctx.font = 'bold 18px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = ink; ctx.fillText('?', 0, 1);
  }
}

/** Theme affects the wrapping only; the five ability symbols remain invariant. */
export function drawPickup(ctx, item = {}, { style = 'classic', highContrast = false } = {}) {
  const theme = styles.has(style) ? style : 'classic';
  const color = pickupColors[item.type] || '#e4e9ed', ink = highContrast ? '#102b3c' : INK;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  oval(ctx, 0, 19, 17, 4, '#24475520', null);
  if (theme === 'candy') {
    poly(ctx, [[-12, -7], [-25, -11], [-22, 0], [-25, 11], [-12, 7]], color, ink, 1.8);
    poly(ctx, [[12, -7], [25, -11], [22, 0], [25, 11], [12, 7]], color, ink, 1.8);
    line(ctx, [[-23, -5], [-16, 0], [-23, 5]], '#ffffff', 1.5);
    line(ctx, [[23, -5], [16, 0], [23, 5]], '#ffffff', 1.5);
    box(ctx, -17, -17, 34, 34, 9, color, ink, highContrast ? 2.7 : 1.8);
    line(ctx, [[-9, -13], [9, -13]], '#ffffff', 2);
  } else if (theme === 'garden') {
    for (let i = 0; i < 6; i++) {
      const angle = i * TAU / 6;
      oval(ctx, Math.cos(angle) * 13, Math.sin(angle) * 13, 8, 7, color, ink, highContrast ? 2 : 1.3, angle);
    }
    leaf(ctx, 15, 15, 6, highContrast ? '#b4d8b0' : '#84bd91', .8);
  } else {
    poly(ctx, [[-10, -18], [10, -18], [19, -9], [19, 9], [10, 18], [-10, 18], [-19, 9], [-19, -9]], color, ink, highContrast ? 2.7 : 1.8);
    oval(ctx, -12, -11, 1.5, 1.5, '#ffffff', null);
    oval(ctx, 12, 11, 1.5, 1.5, '#ffffff', null);
  }
  oval(ctx, 0, 0, 12.5, 12.5, '#ffffff', ink, highContrast ? 2.4 : 1.2);
  pickupSymbol(ctx, item.type, ink);
  ctx.restore();
}
