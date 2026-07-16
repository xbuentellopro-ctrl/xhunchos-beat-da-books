const { createClient } = require("@supabase/supabase-js");

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const APIFY_RUN_URL =
  `https://api.apify.com/v2/acts/zen-studio~prizepicks-player-props/run-sync-get-dataset-items` +
  `?token=${APIFY_API_TOKEN}`;

async function fetchPrizePicksCodProps() {
  const res = await fetch(APIFY_RUN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leagues: ["Call of Duty"] }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Apify error ${res.status}: ${body}`);
  }
  const items = await res.json();
  // Only keep real named-player kill props; skip team-level/blank placeholder rows
  return items.filter(
    (item) => item.player_name && item.player_name.trim().length > 0 && /kills/i.test(item.stat || "")
  );
}

// Groups props by game_start so we can figure out matchup pairs even though
// PrizePicks doesn't give us home/away team names directly.
function buildMatchups(props) {
  const byGameStart = {};
  for (const p of props) {
    const key = p.game_start;
    byGameStart[key] = byGameStart[key] || new Set();
    if (p.player_team) byGameStart[key].add(p.player_team);
  }
  const matchupByGameStart = {};
  for (const [key, teamSet] of Object.entries(byGameStart)) {
    const teams = Array.from(teamSet);
    matchupByGameStart[key] = teams.length === 2 ? `${teams[0]} @ ${teams[1]}` : teams.join(", ");
  }
  return matchupByGameStart;
}

async function getPlayerHistory(playerName, opponentTeam) {
  const { data: allMaps } = await supabase
    .from("cod_player_map_history")
    .select("kills, opponent_slug, match_date")
    .eq("player_name", playerName)
    .order("match_date", { ascending: false });

  if (!allMaps || allMaps.length === 0) return null;

  const recent = allMaps.slice(0, 10);
  const seasonSample = allMaps;
  const vsOpponent = opponentTeam
    ? allMaps.filter((m) => m.opponent_slug === opponentTeam)
    : [];

  return { recent, seasonSample, vsOpponent };
}

function hitRate(maps, line) {
  if (!maps || maps.length === 0) return null;
  const hits = maps.filter((m) => m.kills > line).length;
  return { rate: hits / maps.length, sampleSize: maps.length };
}

function computeBlendedFairProb(history, line) {
  const recentResult = hitRate(history.recent, line);
  const seasonResult = hitRate(history.seasonSample, line);
  const opponentResult = history.vsOpponent.length >= 3 ? hitRate(history.vsOpponent, line) : null;

  if (!recentResult || !seasonResult) return null;

  let opponentWeight = 0.2;
  let seasonWeight = 0.3;
  if (!opponentResult) {
    seasonWeight += opponentWeight;
    opponentWeight = 0;
  }

  const fairProb =
    recentResult.rate * 0.5 + seasonResult.rate * seasonWeight + (opponentResult ? opponentResult.rate * opponentWeight : 0);

  return {
    fairProb,
    recentHitRate: recentResult.rate,
    recentSampleSize: recentResult.sampleSize,
    seasonHitRate: seasonResult.rate,
    seasonSampleSize: seasonResult.sampleSize,
    opponentHitRate: opponentResult ? opponentResult.rate : null,
    opponentSampleSize: opponentResult ? opponentResult.sampleSize : 0,
  };
}

exports.handler = async function () {
  let props;
  try {
    props = await fetchPrizePicksCodProps();
  } catch (err) {
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Failed to fetch PrizePicks CoD props", error: err.message }, null, 2),
    };
  }

  const matchupByGameStart = buildMatchups(props);

  let written = 0;
  let noHistoryCount = 0;
  const sampleNoHistory = [];

  for (const prop of props) {
    const history = await getPlayerHistory(prop.player_name, null);

    let modelFields = {
      fair_prob: null,
      recent_hit_rate: null,
      recent_sample_size: null,
      season_hit_rate: null,
      season_sample_size: null,
      opponent_hit_rate: null,
      opponent_sample_size: null,
      model_note: "No cached history yet for this player",
    };

    if (history) {
      const blended = computeBlendedFairProb(history, prop.line);
      if (blended) {
        modelFields = {
          fair_prob: blended.fairProb,
          recent_hit_rate: blended.recentHitRate,
          recent_sample_size: blended.recentSampleSize,
          season_hit_rate: blended.seasonHitRate,
          season_sample_size: blended.seasonSampleSize,
          opponent_hit_rate: blended.opponentHitRate,
          opponent_sample_size: blended.opponentSampleSize,
          model_note: null,
        };
      }
    }

    if (modelFields.fair_prob == null) {
      noHistoryCount++;
      if (sampleNoHistory.length < 5) sampleNoHistory.push(prop.player_name);
    }

    const { error } = await supabase.from("cod_props").upsert(
      {
        projection_id: prop.projection_id,
        player_name: prop.player_name,
        player_team: prop.player_team,
        matchup: matchupByGameStart[prop.game_start] || null,
        stat: prop.stat,
        pp_line: prop.line,
        game_start: prop.game_start,
        ...modelFields,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "projection_id" }
    );

    if (!error) written++;
  }

  return {
    statusCode: 200,
    body: JSON.stringify(
      {
        message: `Processed ${props.length} CoD props, wrote ${written} rows`,
        noHistoryCount,
        sampleNoHistory,
      },
      null,
      2
    ),
  };
};
