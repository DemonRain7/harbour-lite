import { motionStyle } from './motion-style.js';

// Local simulation only: no timers, network, prompt construction or model calls.
export const BEHAVIOR_LABELS = Object.freeze({ idle: '看看风景', turn: '轻轻转身', walk: '散步中', greet: '向你招手', attentive: '看向你', listen: '听你说', think: '正在思考', reply: '回应你', pat: '轻轻偏过头', rps: '和你猜拳' });
export const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// Build a small connected walking graph, not a city-wide pathfinder. Every edge
// is swept as a capsule, so a thin wall between two clear cells is still blocked.
export function createPatrolGraph(origin, bounds, groundAt, clearAt, step = .8) {
  const nodes = [], byKey = new Map();
  const startGround = groundAt(origin.x, origin.z, origin.ground);
  for (let ix = -8; ix <= 8; ix++) for (let iz = -8; iz <= 8; iz++) {
    const x = origin.x + ix * step, z = origin.z + iz * step;
    if (x < bounds.x0 || x > bounds.x1 || z < bounds.z0 || z > bounds.z1) continue;
    const ground = groundAt(x, z, startGround);
    if (Math.abs(ground - startGround) > .35 || !clearAt(x, z, ground)) continue;
    const node = { x, z, ground, ix, iz, links: [] };
    nodes.push(node); byKey.set(`${ix},${iz}`, node);
  }
  for (const node of nodes) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const other = byKey.get(`${node.ix + dx},${node.iz + dz}`); if (!other) continue;
    let safe = true, lastGround = node.ground;
    for (let i = 1; i <= 8; i++) {
      const x = node.x + (other.x - node.x) * i / 8, z = node.z + (other.z - node.z) * i / 8;
      const ground = groundAt(x, z, lastGround);
      if (Math.abs(ground - lastGround) > .18 || !clearAt(x, z, ground)) { safe = false; break; }
      lastGround = ground;
    }
    if (safe) node.links.push(other);
  }
  const start = byKey.get('0,0');
  if (!start) return []; // Invalid spawn: stay still, never teleport through a wall.
  const connected = new Set([start]), queue = [start];
  for (let i = 0; i < queue.length; i++) for (const next of queue[i].links) if (!connected.has(next)) { connected.add(next); queue.push(next); }
  return queue;
}

export function createResidentBehavior(resident, { graph, random, canMove, groundAt, canRestore = canMove, canSee = () => true, navigator }) {
  const style = motionStyle(resident.id);
  const state = { x: resident.x, z: resident.z, ground: resident.ground, yaw: 0, mode: 'idle', idleGesture: 'idle', speed: 0, time: 0, phase: 0, motionTime: 0, distance: 0 };
  let wait = 1 + random() * 2, path = [], near = false, greetUntil = 0, greetAfter = 0, replyUntil = 0, replySerial = 0, greetSerial = 0, blocked = 0;
  let company = '', nextRoute = 0, lastGoal = null, returning = false;
  const moveTo = mode => {
    if (state.mode !== mode) {
      state.mode = mode; state.phase = 0;
      // Crossing the arms was both severe-looking and poorly fitted to sleeves.
      // Gentle breathing/weight shifts now own idle; no random full-body emote.
      if (mode === 'idle') state.idleGesture = 'idle';
    }
  };
  const validPose = pose => !!pose && [pose.x, pose.z, pose.ground, pose.yaw].every(Number.isFinite)
    && canRestore(pose.x, pose.z, pose.ground) && Math.abs(groundAt(pose.x, pose.z, pose.ground) - pose.ground) < .2;
  const choosePath = () => {
    if (graph.length < 2) return [];
    // After yielding mid-edge, the closest cell may be occupied. Reconnect from
    // our actual position via a swept segment, including a safe backwards step.
    const distance = p => Math.hypot(p.x - state.x, p.z - state.z);
    const starts = graph.filter(p => distance(p) < 1.2).sort((a, b) => distance(a) - distance(b));
    const start = starts.find(p => {
      const steps = Math.max(1, Math.ceil(distance(p) / .1)); let lastGround = state.ground;
      for (let i = 1; i <= steps; i++) {
        const x = state.x + (p.x - state.x) * i / steps, z = state.z + (p.z - state.z) * i / steps;
        const ground = groundAt(x, z, lastGround);
        if (Math.abs(ground - lastGround) > .18 || !canMove(x, z, ground)) return false;
        lastGround = ground;
      }
      return true;
    });
    if (!start) return [];
    const previous = new Map([[start, null]]), queue = [start];
    for (let i = 0; i < queue.length; i++) for (const next of queue[i].links) if (!previous.has(next) && canMove(next.x, next.z, next.ground)) { previous.set(next, queue[i]); queue.push(next); }
    let candidates = queue.filter(p => distance(p) >= 1.6);
    // A narrow aisle may temporarily split the graph; retreat within the reachable
    // component instead of repeatedly picking an unreachable destination forever.
    if (!candidates.length) candidates = queue.filter(p => distance(p) >= .4);
    if (!candidates.length) return [];
    const end = candidates[Math.floor(random() * candidates.length)];
    const result = []; for (let p = end; p; p = previous.get(p)) result.unshift(p);
    // Straight graph cells are not animation waypoints. Keep verified corners,
    // but avoid a stop/start every 65 cm along an otherwise clear aisle.
    return result.filter((p, i) => i === 0 || i === result.length - 1
      || Math.abs((p.x - result[i - 1].x) * (result[i + 1].z - p.z) - (p.z - result[i - 1].z) * (result[i + 1].x - p.x)) > .001);
  };
  return {
    state,
    update(dt, player, activity) {
      dt = Math.min(.05, Math.max(0, dt)); state.time += dt; state.phase += dt;
      const previousSpeed = state.speed; state.speed = 0;
      const distance = Math.abs((player.y ?? state.ground) - state.ground) < 1.5 ? Math.hypot(player.x - state.x, player.z - state.z) : Infinity;
      const companion = activity.social?.companion;
      const nextCompany = companion?.id === resident.id ? companion.mode : '';
      if (company !== nextCompany) {
        returning = !!company && !nextCompany; company = nextCompany;
        path = []; nextRoute = 0; lastGoal = null; blocked = 0;
      }
      state.company = company === 'wait' ? 'waiting' : company ? 'following' : returning ? 'returning' : '';
      const gesture = activity.social?.pose(resident.id);
      state.social = gesture || null;
      if (gesture && distance < 3.8 && canSee(player)) {
        near = true; greetSerial = activity.greetings?.[resident.id] || 0; greetUntil = state.time; greetAfter = state.time + 12;
        moveTo(gesture.type === 'wave' ? 'greet' : gesture.type);
        state.yaw += angleDelta(state.yaw, Math.atan2(player.x - state.x, player.z - state.z)) * (1 - Math.exp(-dt * 4));
        return state;
      }
      const approached = !near && distance < 3.6 && canSee(player);
      if (approached) near = true; else if (distance > 4.6) near = false;
      if (approached && state.time > greetAfter) { greetUntil = state.time + 2.4; greetAfter = state.time + 12; }
      const greeting = activity.greetings?.[resident.id] || 0;
      if (greeting !== greetSerial) {
        greetSerial = greeting;
        if (distance < 3.6 && canSee(player)) { near = true; greetUntil = state.time + 2.4; greetAfter = state.time + 12; }
      }
      const serial = activity.replies?.[resident.id] || 0;
      if (serial !== replySerial) { replySerial = serial; replyUntil = state.time + 4.5; }
      const engaged = activity.selected === resident.id || activity.interacting === resident.id, busy = activity.busy === resident.id;
      // A person standing in the café must not freeze both residents forever.
      // Stop for actual conversation; a brief approach greeting then yields to roaming.
      if (busy || engaged || (!company && !returning && near && (distance < 1.3 || state.time < greetUntil + 2.2)) || state.time < replyUntil) {
        moveTo(busy ? 'think' : state.time < replyUntil ? 'reply' : engaged ? 'listen' : state.time < greetUntil ? 'greet' : 'attentive');
        const targetYaw = Math.atan2(player.x - state.x, player.z - state.z);
        state.yaw += angleDelta(state.yaw, targetYaw) * (1 - Math.exp(-dt * 3));
        return state;
      }
      let speedLimit = style.speed;
      if (company || returning) {
        const facePlayer = () => { moveTo('attentive'); if (distance < 6) state.yaw += angleDelta(state.yaw, Math.atan2(player.x - state.x, player.z - state.z)) * (1 - Math.exp(-dt * 3)); };
        if (company === 'wait') { path = []; facePlayer(); return state; }
        if (company && (distance > 18 || !Number.isFinite(distance))) { path = []; state.company = 'too-far'; facePlayer(); return state; }
        const goal = company ? player : graph.reduce((a, b) => !a || Math.hypot(b.x - state.x, b.z - state.z) < Math.hypot(a.x - state.x, a.z - state.z) ? b : a, null);
        if (returning && (!goal || Math.hypot(goal.x - state.x, goal.z - state.z) < .15)) { returning = false; path = []; state.company = ''; }
        else if (company && distance < (path.length ? 1.6 : 2.1) && canSee(player)) {
          path = []; state.company = 'together'; facePlayer(); return state;
        } else if (goal) {
          if (state.time >= nextRoute && (!path.length || !lastGoal || Math.hypot(goal.x - lastGoal.x, goal.z - lastGoal.z) > 1)) {
            nextRoute = state.time + 1.2; lastGoal = { x: goal.x, z: goal.z };
            path = navigator?.route(state, goal, company ? 1.7 : .12) || [];
          }
          if (!path.length) { state.company = company ? 'blocked' : 'resting'; facePlayer(); return state; }
          // Brisk small steps, not a sprint animation stretched to chase the camera.
          speedLimit = company ? Math.min(2.2, 1.15 + distance * .13) : style.speed;
        } else { returning = false; state.company = ''; }
      }
      if (!path.length) {
        moveTo('idle'); wait -= dt;
        if (wait <= 0) { path = choosePath(); wait = 2.5 + random() * 4; }
        return state;
      }
      while (path.length && Math.hypot(path[0].x - state.x, path[0].z - state.z) < .025) path.shift();
      if (!path.length) { moveTo('idle'); return state; }
      const target = path[0], dx = target.x - state.x, dz = target.z - state.z, distanceTo = Math.hypot(dx, dz);
      const yawError = angleDelta(state.yaw, Math.atan2(dx, dz));
      state.yaw += Math.max(-dt * 2.2, Math.min(dt * 2.2, yawError));
      if (Math.abs(yawError) > .65) { moveTo('turn'); return state; }
      const desired = Math.min(speedLimit * Math.max(0, Math.cos(yawError)), Math.sqrt(2 * .9 * distanceTo));
      const speed = previousSpeed + Math.max(-dt * 1.5, Math.min(dt * .9, desired - previousSpeed));
      const step = Math.min(distanceTo, dt * speed);
      const x = state.x + dx / distanceTo * step, z = state.z + dz / distanceTo * step;
      const ground = groundAt(x, z, state.ground);
      if (Math.abs(ground - state.ground) > (company || returning ? .45 : .18) || !canMove(x, z, ground)) {
        moveTo('idle'); blocked += dt;
        if (blocked > .45) { path = []; blocked = 0; wait = 1 + random() * 2; }
        return state;
      }
      blocked = 0; state.x = x; state.z = z; state.ground = ground;
      state.speed = dt ? step / dt : 0; state.motionTime += step / .68; state.distance += step;
      moveTo('walk'); return state;
    },
    validPose,
    restore(pose) {
      if (!validPose(pose)) return false;
      const ground = groundAt(pose.x, pose.z, pose.ground);
      if (Math.abs(ground - pose.ground) > .2) return false;
      Object.assign(state, { x: pose.x, z: pose.z, ground, yaw: pose.yaw, speed: 0 });
      path = []; nextRoute = 0; return true;
    },
    snapshot: () => ({ ...state, label: BEHAVIOR_LABELS[state.mode], walkableCells: graph.length, navigation: navigator?.status() }),
  };
}

// Player collision follows the resident, not an invisible cylinder left at spawn.
export function separateFromResidents(position, residents, radius = .3) {
  let changed = false;
  for (const r of residents) {
    if (position.y > r.ground + 1.7 || position.y + 1.7 < r.ground) continue;
    const dx = position.x - r.x, dz = position.z - r.z, distance = Math.hypot(dx, dz), min = radius + .32;
    if (distance >= min) continue;
    position.x = r.x + (distance > 1e-6 ? dx / distance : 1) * min;
    position.z = r.z + (distance > 1e-6 ? dz / distance : 0) * min; changed = true;
  }
  return changed;
}
