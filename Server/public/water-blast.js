const DIRECTIONS = [[-1, 0], [1, 0], [0, 1], [0, -1]];
const TAU = Math.PI * 2;

/** Join the water only across two occupied cells. The full danger area is visible on the first frame. */
export function drawWaterBlast(ctx, waves, point, level, highContrast) {
  if (!waves.size) return;
  ctx.save();
  ctx.lineJoin = 'round';
  for (const wave of waves.values()) {
    const { x, y } = point(wave.x, wave.y);
    ctx.beginPath();
    ctx.roundRect(x - 29, y - 27, 58, 54, 13);
    ctx.fillStyle = highContrast ? '#8eddf8' : '#81e3f0be';
    ctx.fill();
    if (highContrast) {
      ctx.strokeStyle = '#00436b';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.save();
      ctx.clip();
      ctx.beginPath();
      for (let offset = -60; offset <= 60; offset += 12) {
        ctx.moveTo(x + offset, y - 30);
        ctx.lineTo(x + offset + 60, y + 30);
      }
      ctx.stroke();
      ctx.restore();
    }
    if (level === 'minimal') continue;

    let horizontal = false, vertical = false;
    let neighbours = 0, tipX = 0, tipY = 0;
    ctx.beginPath();
    ctx.lineCap = 'butt';
    for (const [dx, dy] of DIRECTIONS) {
      if (!waves.has(`${wave.x + dx},${wave.y + dy}`)) continue;
      horizontal ||= dx !== 0;
      vertical ||= dy !== 0;
      neighbours++;
      tipX = -dx;
      tipY = dy;
      ctx.moveTo(x, y);
      ctx.lineTo(x + 30 * dx, y - 30 * dy);
    }
    if (horizontal || vertical) {
      ctx.strokeStyle = highContrast ? '#00436b' : '#1685a3';
      ctx.lineWidth = 25;
      ctx.stroke();
      ctx.strokeStyle = highContrast ? '#a5edf8' : '#4ad2e3';
      ctx.lineWidth = 19;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, TAU);
    ctx.fillStyle = highContrast ? '#a5edf8' : '#4ad2e3';
    ctx.fill();

    // A crest follows the channel without moving its edge or changing the hitbox.
    const ripple = level === 'full' ? Math.sin(wave.ageMs / 100 + wave.x * .7 - wave.y * .7) * 3 : 0;
    if (neighbours === 1) {
      // A curling tip and a pair of drops mark the end of the jet inside its last cell.
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(tipY, tipX));
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.quadraticCurveTo(9, -12, 15, -7 + ripple * .4);
      ctx.quadraticCurveTo(25, -2, 16, 5);
      ctx.quadraticCurveTo(10, 11, 0, 11);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = highContrast ? '#00436b' : '#1685a3';
      ctx.stroke();
      ctx.fillStyle = highContrast ? '#00436b' : '#edffff';
      ctx.beginPath();
      ctx.ellipse(13, -4 + ripple * .4, 4, 1.7, .5, 0, TAU);
      ctx.moveTo(26, -7);
      ctx.arc(24, -7, 2, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.lineCap = 'round';
    ctx.lineWidth = highContrast ? 3 : 2.5;
    ctx.strokeStyle = highContrast ? '#00436b' : '#edffff';
    ctx.beginPath();
    if (horizontal || !vertical) {
      ctx.moveTo(x - 13 + ripple, y - 4);
      ctx.quadraticCurveTo(x - 5 + ripple, y - 9, x + 2 + ripple, y - 5);
    }
    if (vertical) {
      ctx.moveTo(x + 4, y + 13 - ripple);
      ctx.quadraticCurveTo(x + 9, y + 5 - ripple, x + 5, y - 2 - ripple);
    }
    ctx.stroke();
  }
  ctx.restore();
}
