// WNBA data via BallDontLie (requires ALL-STAR tier or higher, WNBA-specific
// subscription -- paid tiers don't carry across sports on their platform).
// Base path pattern mirrors their NBA API (api.balldontlie.io/{sport}/v1/...)
// per their docs structure -- if this 404s on first real run, the sport
// segment in BDL_BASE below is the first thing to check/adjust.

const BDL_API_KEY = process.env.BALLDONTLIE_API_KEY;
const BDL_BASE = "https://api.balldontlie.io/wnba/v1";
const SEASON = new Date().getFullYear();

const MARKET_TO_BDL_STAT = {
  player_points: "pts",
  player_rebounds: "reb",
  player_assists: "ast",
  player_threes: "fg3m",
};

// team_season_averages "general/opponent" gives what opponents average
// AGAINST this team -- i.e. exactly the "how generous is this defense" read
// we want, keyed the same as the raw stat fields.
const MARKET_TO_OPPONENT_STAT = {
  player_points: "pts",
  player_rebounds: "reb",
  player_assists: "ast",
  player_threes: "fg3m",
};

// Minimum gap enforced between outgoing BDL requests, and retry behavior for
// rate-limit (429) responses. Default here is tuned for the 48-hour trial's
// 5 req/min cap (12.5s between requests). Once on a real paid plan (e.g.
// ALL-STAR at 60 req/min), set BALLDONTLIE_MIN_GAP_MS=1100 in Netlify's env
// vars to speed this up roughly 10x.
const MIN_REQUEST_GAP_MS = Number(process.env.BALLDONTLIE_MIN_GAP_MS) || 12500;
const MAX_RETRIES = 3;
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bdlFetch(path, params = {}) {
  const url = new URL(`${BDL_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((v) => url.searchParams.append(`${key}[]`, v));
    } else if (value != null) {
      url.searchParams.set(key, value);
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const sinceLast = Date.now() - lastRequestAt;
    if (sinceLast < MIN_REQUEST_GAP_MS) await sleep(MIN_REQUEST_GAP_MS - sinceLast);
    lastRequestAt = Date.now();

    const res = await fetch(url.toString(), { headers: { Authorization: BDL_API_KEY } });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt * 2;
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`BallDontLie error ${res.status}: ${body}`);
    }

    return res.json();
  }
}

let teamsCache = null;
async function getAllTeams() {
  if (teamsCache) return teamsCache;
  const data = await bdlFetch("/teams");
  teamsCache = data.data || [];
  return teamsCache;
}

async function findTeamByName(name) {
  const teams = await getAllTeams();
  const lower = name.toLowerCase();
  return (
    teams.find((t) => t.full_name?.toLowerCase() === lower) ||
    teams.find((t) => lower.includes((t.name || "").toLowerCase())) ||
    teams.find((t) => (t.full_name || "").toLowerCase().includes(lower)) ||
    null
  );
}

async function findPlayer(playerName) {
  const data = await bdlFetch("/players", { search: playerName, per_page: 5 });
  const players = data.data || [];
  if (players.length === 0) return null;
  const full = (p) => `${p.first_name} ${p.last_name}`.toLowerCase();
  const exact = players.find((p) => full(p) === playerName.toLowerCase());
  return exact || players[0];
}

/**
 * Last-N-games stat log for a player this season, oldest game first.
 */
async function getRecentGameLog(playerId, statField, maxGames = 15) {
  const data = await bdlFetch("/stats", {
    player_ids: [playerId],
    seasons: [SEASON],
    per_page: 100,
  });
  const rows = (data.data || [])
    .filter((s) => s[statField] != null && s.game?.date)
    .map((s) => ({ date: s.game.date, value: Number(s[statField]) }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  return rows.slice(-maxGames).map((r) => r.value);
}

let leagueAvgCache = {};
async function getLeagueAverageOpponentStat(statField) {
  if (leagueAvgCache[statField] != null) return leagueAvgCache[statField];

  const data = await bdlFetch("/team_season_averages/general", {
    season: SEASON,
    season_type: "regular",
    type: "opponent",
  });
  const values = (data.data || [])
    .map((row) => row.stats?.[statField])
    .filter((v) => v != null)
    .map(Number);

  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  leagueAvgCache[statField] = avg;
  return avg;
}

let teamStatCache = {};
async function getTeamOpponentStat(teamId, statField) {
  const cacheKey = `${teamId}:${statField}`;
  if (teamStatCache[cacheKey] !== undefined) return teamStatCache[cacheKey];

  const data = await bdlFetch("/team_season_averages/general", {
    season: SEASON,
    season_type: "regular",
    type: "opponent",
    team_ids: [teamId],
  });
  const row = (data.data || [])[0];
  const value = row?.stats?.[statField] != null ? Number(row.stats[statField]) : null;
  teamStatCache[cacheKey] = value;
  return value;
}

module.exports = {
  MARKET_TO_BDL_STAT,
  MARKET_TO_OPPONENT_STAT,
  findTeamByName,
  findPlayer,
  getRecentGameLog,
  getLeagueAverageOpponentStat,
  getTeamOpponentStat,
};
