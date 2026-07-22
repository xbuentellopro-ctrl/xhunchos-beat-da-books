const { createClient } = require("@supabase/supabase-js");
const { weightedMeanStdev, modelProbabilities, clampFactor } = require("./lib/stats-math");
const mlb = require("./lib/mlb-stats");
const wnba = require("./lib/wnba-stats");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// -- player ID cache (Supabase-backed, shared across runs) -----------------

async function getCachedPlayerId(sport, playerName) {
  const { data } = await supabase
    .from("player_id_cache")
    .select("external_id, external_team_id")
    .eq("sport", sport)
    .eq("player_name", playerName)
    .maybeSingle();
  return data || null;
}

async function cachePlayerId(sport, playerName, externalId, externalTeamId) {
  await supabase
    .from("player_id_cache")
    .upsert(
      { sport, player_name: playerName, external_id: externalId, external_team_id: externalTeamId, cached_at: new Date().toISOString() },
      { onConflict: "sport,player_name" }
    );
}

// -- per-sport prop processing ----------------------------------------------

function parseMatchup(matchup) {
  // "Away Team @ Home Team"
  const parts = (matchup || "").split(" @ ");
  return { away: parts[0]?.trim(), home: parts[1]?.trim() };
}

async function processMlbProp(prop) {
  const statField = mlb.MARKET_TO_MLB_STAT[prop.market_key];
  const pitchingField = mlb.MARKET_TO_PITCHING_STAT[prop.market_key];
  if (!statField) return { error: `Unsupported MLB market: ${prop.market_key}` };

  let cached = await getCachedPlayerId("MLB", prop.player);
  let personId = cached?.external_id;
  let playerTeamId = cached?.external_team_id;

  if (!personId) {
    const found = await mlb.findPlayer(prop.player);
    if (!found) return { error: `Player not found: ${prop.player}` };
    personId = found.id;
    playerTeamId = found.currentTeam?.id || null;
    await cachePlayerId("MLB", prop.player, String(personId), playerTeamId ? String(playerTeamId) : null);
  }

  const gameLog = await mlb.getRecentGameLog(personId, statField);
  const { mean, stdev, n } = weightedMeanStdev(gameLog);
  if (mean == null) return { error: `No recent game log for ${prop.player}` };

  // Figure out the opponent: whichever team in the matchup isn't the player's own team
  const { away, home } = parseMatchup(prop.matchup);
  const [awayTeam, homeTeam] = await Promise.all([mlb.findTeamByName(away), mlb.findTeamByName(home)]);
  const opponentTeam =
    playerTeamId && awayTeam?.id === Number(playerTeamId) ? homeTeam : awayTeam || homeTeam;

  let opponentFactor = 1.0;
  if (opponentTeam) {
    const [oppStat, leagueAvg] = await Promise.all([
      mlb.getTeamPitchingStat(opponentTeam.id, pitchingField),
      mlb.getLeagueAveragePitchingStat(pitchingField),
    ]);
    if (oppStat != null && leagueAvg) {
      // For ERA/WHIP/HR9, HIGHER opponent value = weaker pitching = should
      // BOOST the batter's projection, so the ratio is opponent/league (not inverted).
      opponentFactor = clampFactor(oppStat / leagueAvg);
    }
  }

  const adjustedMean = mean * opponentFactor;
  const { probOver, probUnder } = modelProbabilities(adjustedMean, stdev, prop.pp_line);

  return {
    sample_size: n,
    recent_mean: mean,
    recent_stdev: stdev,
    opponent_factor: opponentFactor,
    adjusted_mean: adjustedMean,
    model_prob_over: probOver,
    model_prob_under: probUnder,
    data_source: "mlb_stats_api",
  };
}

async function processWnbaProp(prop) {
  const statField = wnba.MARKET_TO_BDL_STAT[prop.market_key];
  const opponentField = wnba.MARKET_TO_OPPONENT_STAT[prop.market_key];
  if (!statField) return { error: `Unsupported WNBA market: ${prop.market_key}` };

  let cached = await getCachedPlayerId("WNBA", prop.player);
  let playerId = cached?.external_id;
  let playerTeamId = cached?.external_team_id;

  if (!playerId) {
    const found = await wnba.findPlayer(prop.player);
    if (!found) return { error: `Player not found: ${prop.player}` };
    playerId = found.id;
    playerTeamId = found.team?.id || null;
    await cachePlayerId("WNBA", prop.player, String(playerId), playerTeamId ? String(playerTeamId) : null);
  }

  const gameLog = await wnba.getRecentGameLog(playerId, statField);
  const { mean, stdev, n } = weightedMeanStdev(gameLog);
  if (mean == null) return { error: `No recent game log for ${prop.player}` };

  const { away, home } = parseMatchup(prop.matchup);
  const [awayTeam, homeTeam] = await Promise.all([wnba.findTeamByName(away), wnba.findTeamByName(home)]);
  const opponentTeam =
    playerTeamId && awayTeam?.id === Number(playerTeamId) ? homeTeam : awayTeam || homeTeam;

  let opponentFactor = 1.0;
  if (opponentTeam) {
    const [oppStat, leagueAvg] = await Promise.all([
      wnba.getTeamOpponentStat(opponentTeam.id, opponentField),
      wnba.getLeagueAverageOpponentStat(opponentField),
    ]);
    if (oppStat != null && leagueAvg) {
      opponentFactor = clampFactor(oppStat / leagueAvg);
    }
  }

  const adjustedMean = mean * opponentFactor;
  const { probOver, probUnder } = modelProbabilities(adjustedMean, stdev, prop.pp_line);

  return {
    sample_size: n,
    recent_mean: mean,
    recent_stdev: stdev,
    opponent_factor: opponentFactor,
    adjusted_mean: adjustedMean,
    model_prob_over: probOver,
    model_prob_under: probUnder,
    data_source: "balldontlie",
  };
}

// -- main handler -------------------------------------------------------

// WNBA on the BallDontLie 48-hour trial is capped at 5 req/min. As a
// background function this now has up to 15 minutes to run instead of the
// ~10-26s a normal function gets, so a much larger batch fits comfortably
// within that window even at the trial's slow pacing. Raise further once on
// a real paid plan with a faster rate limit.
const WNBA_BATCH_LIMIT = 15;

exports.handler = async function () {
  const now = new Date().toISOString();

  // Only project props for upcoming games that actually have a PrizePicks
  // line -- no point modeling something that isn't a live pick opportunity.
  // Query each sport separately (not combined with a shared limit): MLB
  // generates far more prop rows per day than WNBA, so a single combined
  // query with one limit can fill entirely with MLB rows before WNBA is
  // ever read. Separate queries guarantee WNBA gets its own slice.
  const propsBySport = {};
  for (const sport of ["MLB", "WNBA"]) {
    const { data, error } = await supabase
      .from("props")
      .select("id, player, sport, stat, matchup, market_key, commence_time, pp_lines ( pp_line )")
      .gte("commence_time", now)
      .eq("sport", sport)
      .order("commence_time", { ascending: true })
      .limit(200);

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: `${sport}: ${error.message}` }) };
    }
    propsBySport[sport] = data || [];
  }

  // Skip props that already have a successful projection -- no need to
  // re-spend rate-limited WNBA calls re-computing something already done.
  // Props with a prior error (rate-limited, not-found, etc.) are retried.
  const { data: alreadyProjected } = await supabase
    .from("stat_projections")
    .select("prop_id")
    .is("error", null)
    .not("model_prob_over", "is", null);
  const doneIds = new Set((alreadyProjected || []).map((r) => r.prop_id));

  propsBySport.MLB = propsBySport.MLB.filter((p) => !doneIds.has(p.id));
  propsBySport.WNBA = propsBySport.WNBA.filter((p) => !doneIds.has(p.id)).slice(0, WNBA_BATCH_LIMIT);

  const props = [...propsBySport.MLB, ...propsBySport.WNBA];

  let processed = 0;
  let errors = [];

  for (const prop of props || []) {
    const ppLineRaw = prop.pp_lines;
    const ppLine = Array.isArray(ppLineRaw) ? ppLineRaw[0]?.pp_line : ppLineRaw?.pp_line;
    if (ppLine == null) continue;

    const propWithLine = { ...prop, pp_line: ppLine };

    let result;
    try {
      result = prop.sport === "MLB" ? await processMlbProp(propWithLine) : await processWnbaProp(propWithLine);
    } catch (err) {
      result = { error: err.message };
    }

    if (result.error) {
      errors.push({ player: prop.player, sport: prop.sport, error: result.error });
      await supabase.from("stat_projections").upsert(
        {
          prop_id: prop.id,
          sport: prop.sport,
          player: prop.player,
          stat: prop.stat,
          market_key: prop.market_key,
          error: result.error,
          computed_at: new Date().toISOString(),
        },
        { onConflict: "prop_id" }
      );
      continue;
    }

    await supabase.from("stat_projections").upsert(
      {
        prop_id: prop.id,
        sport: prop.sport,
        player: prop.player,
        stat: prop.stat,
        market_key: prop.market_key,
        ...result,
        error: null,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "prop_id" }
    );
    processed++;
  }

  const summary = {
    message: `Computed ${processed} projections, ${errors.length} errors`,
    propsConsidered: {
      MLB: propsBySport.MLB.length,
      WNBA: propsBySport.WNBA.length,
    },
    note: `WNBA is capped at ${WNBA_BATCH_LIMIT} new props per run on the BallDontLie trial's rate limit -- run this again (or wait for the next cron cycle) to cover more of the slate.`,
    sampleErrors: errors.slice(0, 10),
  };

  // Background functions don't return their body to whoever triggered them
  // (the caller gets an immediate 202 and this runs asynchronously) -- log
  // the summary so it's visible in Netlify's function log instead.
  console.log(JSON.stringify(summary, null, 2));

  return {
    statusCode: 200,
    body: JSON.stringify(summary, null, 2),
  };
};
