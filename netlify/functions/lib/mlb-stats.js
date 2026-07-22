// Free, no-auth MLB Stats API integration (statsapi.mlb.com).
// Docs: https://github.com/pseudo-r/Public-MLB-API

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const SEASON = new Date().getFullYear();

// Maps our market_key (from the Odds API / props table) to the MLB Stats
// API's hitting stat field name in a gameLog split.
const MARKET_TO_MLB_STAT = {
  batter_hits: "hits",
  batter_total_bases: "totalBases",
  batter_home_runs: "homeRuns",
};

// Opponent-side pitching stat used to adjust the projection for each market.
// Lower ERA/WHIP = tougher pitching = suppresses the batter's projection;
// higher = more generous = boosts it.
const MARKET_TO_PITCHING_STAT = {
  batter_hits: "whip",
  batter_total_bases: "whip",
  batter_home_runs: "homeRunsPer9",
};

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB Stats API error ${res.status} for ${url}`);
  return res.json();
}

let teamsCache = null;
async function getAllTeams() {
  if (teamsCache) return teamsCache;
  const data = await fetchJSON(`${MLB_BASE}/teams?sportId=1&season=${SEASON}`);
  teamsCache = data.teams || [];
  return teamsCache;
}

/**
 * Find the MLB team object whose name best matches a free-text team name
 * (e.g. "New York Yankees" from the Odds API matchup string).
 */
async function findTeamByName(name) {
  const teams = await getAllTeams();
  const lower = name.toLowerCase();
  return (
    teams.find((t) => t.name.toLowerCase() === lower) ||
    teams.find((t) => lower.includes(t.teamName.toLowerCase())) ||
    teams.find((t) => t.name.toLowerCase().includes(lower)) ||
    null
  );
}

/**
 * Resolve a player's MLB personId + current team by name search.
 */
async function findPlayer(playerName) {
  const data = await fetchJSON(`${MLB_BASE}/people/search?names=${encodeURIComponent(playerName)}`);
  const people = data.people || [];
  if (people.length === 0) return null;
  // Prefer an exact (case-insensitive) full-name match if multiple results come back
  const exact = people.find((p) => p.fullName?.toLowerCase() === playerName.toLowerCase());
  return exact || people[0];
}

/**
 * Get a player's last-N-games hitting log for the current season, oldest
 * game first (so stats-math's recency weighting applies correctly).
 */
async function getRecentGameLog(personId, statField, maxGames = 15) {
  const data = await fetchJSON(
    `${MLB_BASE}/people/${personId}/stats?stats=gameLog&group=hitting&season=${SEASON}`
  );
  const splits = data.stats?.[0]?.splits || [];
  const values = splits
    .filter((s) => s.stat && s.stat[statField] != null)
    .map((s) => ({ date: s.date, value: Number(s.stat[statField]) }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const recent = values.slice(-maxGames);
  return recent.map((r) => r.value);
}

let leagueAvgCache = {};
/**
 * League-average value for a given pitching stat this season, computed by
 * averaging every team's season pitching stat. Cached per stat within a
 * single function invocation.
 */
async function getLeagueAveragePitchingStat(statField) {
  if (leagueAvgCache[statField] != null) return leagueAvgCache[statField];

  const teams = await getAllTeams();
  const values = [];
  for (const team of teams) {
    try {
      const data = await fetchJSON(
        `${MLB_BASE}/teams/${team.id}/stats?stats=season&group=pitching&season=${SEASON}`
      );
      const stat = data.stats?.[0]?.splits?.[0]?.stat;
      if (stat && stat[statField] != null) values.push(Number(stat[statField]));
    } catch {
      // skip teams with no data yet, don't fail the whole average
    }
  }
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  leagueAvgCache[statField] = avg;
  return avg;
}

async function getTeamPitchingStat(teamId, statField) {
  const data = await fetchJSON(
    `${MLB_BASE}/teams/${teamId}/stats?stats=season&group=pitching&season=${SEASON}`
  );
  const stat = data.stats?.[0]?.splits?.[0]?.stat;
  return stat && stat[statField] != null ? Number(stat[statField]) : null;
}

module.exports = {
  MARKET_TO_MLB_STAT,
  MARKET_TO_PITCHING_STAT,
  findTeamByName,
  findPlayer,
  getRecentGameLog,
  getLeagueAveragePitchingStat,
  getTeamPitchingStat,
};
