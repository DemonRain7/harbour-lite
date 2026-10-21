// Shared by navigation and animation. Metres/seconds, not source-rig units.
// Personality is a small variation of the same comfortable café gait.
const styles = {
  'main-elaina': { speed: .72, stride: .86, lift: .055, sway: .005, gesture: .8 },
  'main-aemeath': { speed: .80, stride: .92, lift: .065, sway: .007, gesture: 1 },
  chisa: { speed: .76, stride: .88, lift: .060, sway: .005, gesture: .75 },
};
for (const style of Object.values(styles)) Object.freeze(style);
export const MOTION_STYLES = Object.freeze(styles);
export const motionStyle = id => MOTION_STYLES[id] || MOTION_STYLES.chisa;
export const smoothStep = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

// Stance occupies slightly more than half a cycle: a short double support,
// rather than a bouncing run. Distance drives phase, including when slowed.
export const STANCE = .58;
export function gaitPhase(cycle, side = 0) {
  const phase = ((cycle + side) % 1 + 1) % 1;
  return { phase, planted: phase < STANCE, swing: smoothStep((phase - STANCE) / (1 - STANCE)) };
}
