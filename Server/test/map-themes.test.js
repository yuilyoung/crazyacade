import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as catalog from '../public/map-catalog.js';
import { drawMapMiniature } from '../public/arena-renderer.js';

test('map previews share unique arena palettes and useful landmark descriptions', () => {
  assert.equal(typeof catalog.mapTheme, 'function');
  const floors = new Set();
  for (const map of catalog.MAPS) {
    const theme = catalog.mapTheme(map.id); floors.add(theme.floor);
    assert.ok(Object.isFrozen(theme)); assert.ok(theme.landmark && theme.strategy);
    const colors = [];
    const ctx = {fillRect(){colors.push(this.fillStyle);}};
    drawMapMiniature({getContext:()=>ctx,style:{}}, {mapId:map.id,mode:'team'});
    assert.ok(colors.includes(theme.wall)); assert.ok(colors.includes(theme.floor));
  }
  assert.equal(floors.size,5);
  assert.equal(catalog.mapTheme('invalid'),catalog.mapTheme('garden'));
});
