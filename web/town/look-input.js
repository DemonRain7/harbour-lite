// Radians are applied by TownMotion at 0.0022 per pixel. Edge turning
// is time based, so a stationary cursor can turn around at any refresh rate.
export function edgeLookVelocity(x, width) {
  const band = Math.min(64, width * .09);
  if (!Number.isFinite(x) || x < 0 || x > width || width <= 0) return 0;
  const strength = x < band ? -(1 - x / band) : x > width - band ? (x - width + band) / band : 0;
  return Math.sign(strength) * strength * strength * 540;
}
