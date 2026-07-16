const { createClient } = require("@supabase/supabase-js");

const CITO_API_KEY = process.env.CITO_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// CDL teams currently tracked by Cito (confirmed live 2026-07-16).
// Update this list if new franchises appear in /cod/matches/upcoming.
const TRACKED_TEAMS = [
  "toronto-koi",
  "paris-gentle-mates",
  "optic-texas",
  "miami-heretics",
  "faze-vegas",
  "g2-minnesota",
];

const MATCHES_PER_TEAM = 8; // how far back to look per team, to conserve quota

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { "x-api-key": CITO_API_KEY } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cito API error ${res.status}: ${body}`);
  }
  return res.json();
}

async function processTeam(teamSlug) {
  const matchesUrl = `https://api.citoapi.com/api/v1/cod/teams/${teamSlug}/matches`;
  let matchesResp;
  try {
    matchesResp = await fetchJSON(matchesUrl);
  } catch (err) {
    return { teamSlug, error: err.message, matchesProcessed: 0, mapRowsWritten: 0 };
  }

  const matches = (matchesResp.data || []).slice(0, MATCHES_PER_TEAM);
  let mapRowsWritten = 0;
  const sampleErrors = [];
  let playersSeenTotal = 0;
  let matchesWithNoPlayers = 0;

  for (const match of matches) {
    const matchId = match.matchId || match.id;
    if (!matchId) continue;

    const cacheCheck = await supabase
      .from("cod_team_match_cache")
      .select("id")
      .eq("team_slug", teamSlug)
      .eq("match_id", matchId)
      .maybeSingle();

    if (cacheCheck.data) continue; // already cached, skip re-fetching to save quota

    let statsResp;
    try {
      statsResp = await fetchJSON(
        `https://api.citoapi.com/api/v1/cod/matches/${matchId}/player-stats?includeMaps=true`
      );
    } catch (err) {
      sampleErrors.push(err.message);
      continue;
    }

    const opponentSlug =
      match.team1?.slug === teamSlug ? match.team2?.slug : match.team1?.slug;
    const matchDate = match.startsAt || match.matchDate || null;

    await supabase.from("cod_team_match_cache").upsert(
      { team_slug: teamSlug, match_id: matchId, opponent_slug: opponentSlug, match_date: matchDate },
      { onConflict: "team_slug,match_id" }
    );

    const playerRows = statsResp.data?.players || [];
    playersSeenTotal += playerRows.length;
    if (playerRows.length === 0) matchesWithNoPlayers++;

    for (const player of playerRows) {
      const citoPlayerId = player.playerId;
      const playerName = player.playerName;
      if (!citoPlayerId || !playerName) continue;

      const maps = player.maps || [];
      for (const mapRow of maps) {
        const kills = mapRow.stats?.kills;
        if (kills == null) continue;

        const { error } = await supabase.from("cod_player_map_history").upsert(
          {
            cito_player_id: citoPlayerId,
            player_name: playerName,
            team_slug: teamSlug,
            opponent_slug: opponentSlug,
            match_id: matchId,
            map_number: mapRow.mapNumber,
            kills,
            match_date: matchDate,
          },
          { onConflict: "cito_player_id,match_id,map_number" }
        );
        if (!error) {
          mapRowsWritten++;
        } else if (sampleErrors.length < 2) {
          sampleErrors.push(error.message);
        }
      }
    }
  }

  return {
    teamSlug,
    matchesProcessed: matches.length,
    playersSeenTotal,
    matchesWithNoPlayers,
    mapRowsWritten,
    sampleErrors: sampleErrors.slice(0, 2),
  };
}

exports.handler = async function () {
  const results = [];
  for (const teamSlug of TRACKED_TEAMS) {
    const result = await processTeam(teamSlug);
    results.push(result);
    // small delay between teams to stay well under Cito's rate limit
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "CoD history refresh complete", results }, null, 2),
  };
};
