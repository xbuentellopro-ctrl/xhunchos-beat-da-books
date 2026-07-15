// De-vig math: converts American odds into a fair (no-vig) implied probability

/**
 * Convert American odds to raw implied probability (includes vig).
 */
function americanToImplied(odds) {
  if (odds < 0) return -odds / (-odds + 100);
  return 100 / (odds + 100);
}

/**
 * Given the American odds for both sides of a two-way market (Over/Under),
 * return the de-vigged fair probability for each side.
 * This uses the standard "multiplicative" no-vig method: normalize both
 * implied probabilities so they sum to 1.
 */
function devigTwoWay(overOdds, underOdds) {
  const impliedOver = americanToImplied(overOdds);
  const impliedUnder = americanToImplied(underOdds);
  const overround = impliedOver + impliedUnder; // > 1 due to vig

  return {
    overFairProb: impliedOver / overround,
    underFairProb: impliedUnder / overround,
    overround, // e.g. 1.045 means ~4.5% total vig
  };
}

module.exports = { americanToImplied, devigTwoWay };
