// Bounded, on-demand local navigation. No city-sized navmesh, scene raycasts,
// async worker or allocation on every render frame. Obstacles are capsule-swept.
export function createCompanionNavigator({ canMove, groundAt, bounds }) {
  let searches = 0, lastExpanded = 0;
  const inside = (x, z) => !bounds || (x >= bounds.x0 && x <= bounds.x1 && z >= bounds.z0 && z <= bounds.z1);
  function sweep(a, b) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / .12));
    let ground = a.ground;
    for (let i = 1; i <= n; i++) {
      const x = a.x + (b.x - a.x) * i / n, z = a.z + (b.z - a.z) * i / n;
      const next = groundAt(x, z, ground);
      if (!Number.isFinite(next) || Math.abs(next - ground) > .45 || !inside(x, z) || !canMove(x, z, next)) return null;
      ground = next;
    }
    return { x: b.x, z: b.z, ground };
  }
  function route(start, target, radius = 1.7) {
    searches++; lastExpanded = 0;
    const distance = p => Math.hypot(target.x - p.x, target.z - p.z);
    if (distance(start) > 18 || Math.abs((target.y ?? target.ground) - start.ground) > 1.2) return [];
    if (distance(start) <= radius) return [];
    const ratio = Math.max(0, 1 - radius / distance(start));
    const direct = sweep(start, { x: start.x + (target.x - start.x) * ratio, z: start.z + (target.z - start.z) * ratio });
    if (direct) return [direct];
    const step = .65, root = { ...start, ix: 0, iz: 0, cost: 0, parent: null };
    const open = [root], best = new Map([['0,0', 0]]), closed = new Set();
    while (open.length && lastExpanded < 240) {
      let index = 0;
      for (let i = 1; i < open.length; i++) if (open[i].cost + distance(open[i]) < open[index].cost + distance(open[index])) index = i;
      const current = open.splice(index, 1)[0], key = `${current.ix},${current.iz}`;
      if (closed.has(key)) continue;
      closed.add(key); lastExpanded++;
      if (distance(current) <= radius) {
        const path = []; for (let p = current; p.parent; p = p.parent) path.unshift({ x: p.x, z: p.z, ground: p.ground });
        // Smooth only verified segments, keeping corners around furniture.
        const result = []; let from = start;
        for (let i = 0; i < path.length;) {
          let j = i; while (j + 1 < path.length && sweep(from, path[j + 1])) j++;
          result.push(path[j]); from = path[j]; i = j + 1;
        }
        return result;
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const ix = current.ix + dx, iz = current.iz + dz, nextKey = `${ix},${iz}`;
        if (Math.abs(ix) > 28 || Math.abs(iz) > 28 || closed.has(nextKey)) continue;
        const cost = current.cost + Math.hypot(dx, dz) * step;
        if ((best.get(nextKey) ?? Infinity) <= cost) continue;
        const point = sweep(current, { x: start.x + ix * step, z: start.z + iz * step });
        if (!point) continue;
        best.set(nextKey, cost); open.push({ ...point, ix, iz, cost, parent: current });
      }
    }
    return []; // Never substitute a teleport or a path through an obstacle.
  }
  return { route, sweep, status: () => ({ searches, lastExpanded, maxExpanded: 240 }) };
}
