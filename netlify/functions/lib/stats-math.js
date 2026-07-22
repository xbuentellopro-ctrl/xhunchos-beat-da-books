// Statistical helpers shared by the MLB and WNBA projection pipelines.

/**
 * Recency-weighted mean and standard deviation over an array of numeric
 * values, ordered OLDEST -> NEWEST. More recent games get more weight
 * (linear ramp) so a player's current form matters more than a game from
 * 3 weeks ago, without fully ignoring the older games.
 */
function weightedMeanStdev(values) {
  const n = values.length;
  if (n === 0) return { mean: null, stdev: null, n: 0 };

  // weight 1..n, oldest gets weight 1, newest gets weight n
  const weights = values.map((_, i) => i + 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const mean = values.reduce((sum, v, i) => sum + v * weights[i], 0) / totalWeight;

  const variance =
    values.reduce((sum, v, i) => sum + weights[i] * Math.pow(v - mean, 2), 0) / totalWeight;

  // Floor the stdev so a perfectly consistent short sample doesn't produce
  // an unrealistically narrow (overconfident) distribution.
  const stdev = Math.max(Math.sqrt(variance), 0.35);

  return { mean, stdev, n };
}

/**
 * Standard normal cumulative distribution function via the Abramowitz &
 * Stegun approximation (accurate to ~1e-7). No external stats library needed.
 */
function standardNormalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.SQRT2;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * z);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1 + sign * y);
}

/**
 * Given an adjusted projected mean/stdev and a PrizePicks line, return the
 * model's probability of the stat landing OVER and UNDER that line.
 * Uses a 0.5 continuity correction since these are discrete counting stats
 * (hits, points, etc.) being approximated with a continuous distribution.
 */
function modelProbabilities(adjustedMean, stdev, line) {
  const z = (line + 0.5 - adjustedMean) / stdev;
  const probUnder = standardNormalCdf(z);
  const probOver = 1 - probUnder;
  return { probOver, probUnder };
}

/**
 * Clamp an opponent adjustment factor to a reasonable band so one noisy
 * data point (e.g. a team that's faced 3 games all year) can't blow the
 * projection up or down unrealistically.
 */
function clampFactor(factor, min = 0.75, max = 1.3) {
  if (factor == null || Number.isNaN(factor)) return 1.0;
  return Math.min(max, Math.max(min, factor));
}

module.exports = { weightedMeanStdev, standardNormalCdf, modelProbabilities, clampFactor };
