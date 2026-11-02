function normalize(selection = {}) {
  const mode = selection?.mode === 'duel' ? 'duel' : 'team';
  return {
    roomId: typeof selection?.roomId === 'string' ? selection.roomId.trim().slice(0, 64) : '',
    mode,
    mapId: ['garden', 'lagoon', 'candy'].includes(selection?.mapId) ? selection.mapId : 'garden',
    itemMode: selection?.itemMode !== false,
    ruleSet: mode === 'team' && selection?.ruleSet === 'relay' ? 'relay' : 'classic'
  };
}

export function buildInviteUrl(locationHref, selection = {}) {
  if (selection?.practice === true) throw new Error('Private practice rooms cannot be shared.');
  const source = new URL(locationHref);
  if (!['http:', 'https:'].includes(source.protocol)) throw new Error('An HTTP or HTTPS origin is required.');
  // Start afresh: neither browser auth fragments nor unrelated query data belong in invitations.
  const url = new URL(source.origin);
  url.pathname = source.pathname;
  const { roomId, mode, mapId, itemMode, ruleSet } = normalize(selection);
  url.search = new URLSearchParams({ room: roomId, mode, map: mapId, items: itemMode ? '1' : '0', rules: ruleSet }).toString();
  return url.href;
}

export function parseInvite(search = '') {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  return normalize({
    roomId: params.get('room'), mode: params.get('mode'), mapId: params.get('map'),
    itemMode: params.get('items') !== '0', ruleSet: params.get('rules')
  });
}
