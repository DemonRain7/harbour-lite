// Keep an explicitly visited resident selected while the player is still facing
// them. Eligibility is unchanged: no interaction through walls or across floors.
export function selectNearbyResident(residents, player, direction, preferredId = '') {
  let nearest = null, bestScore = Infinity;
  for (const r of residents) {
    const distance = Math.hypot(player.x - r.x, player.z - r.z);
    if (distance >= 3.6 || Math.abs(player.y - r.ground) >= 1.5) continue;
    const facing = distance > .01 ? ((r.x - player.x) * direction.x + (r.z - player.z) * direction.z) / distance : 1;
    if (facing <= .25 || !r.canSee(player)) continue;
    if (r.id === preferredId) return r;
    const score = 1 - facing + distance * .03;
    if (score < bestScore) { nearest = r; bestScore = score; }
  }
  return nearest;
}
