// Pure authoritative transition checks; baselines never replay old effects.
export function combatSounds(before, after) {
  if (!before || before.match!==after.match || before.phase!=='playing' || after.phase!=='playing') return [];
  const sounds=[];
  if(after.alive && after.bubbleTicks>0 && !(before.bubbleTicks>0)) sounds.push('capture');
  if(after.alive && before.bubbleTicks>0 && !(after.bubbleTicks>0)) sounds.push('escape');
  if((after.wallHits ?? 0)>(before.wallHits ?? 0)) sounds.push('wall');
  return sounds;
}
