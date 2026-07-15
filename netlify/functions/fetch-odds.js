// netlify/functions/fetch-odds.js
// Scheduled Netlify function — pulls NBA player prop odds from The Odds API,
// de-vigs them, and upserts into Supabase. Mirrors the send-reminders.js pattern.
//
// Netlify scheduled function config (netlify.toml):
//   [[scheduled.functions]]
//     function = "fetch-odds"
//     cron = "0 */2 * * *"   # every 2 hours — tune based on your quota

const { createClient } = require("@supabase/supabase-js");
const { devigTwoWay } = require("./devig");

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Sport + market keys to pull. Start narrow, expand once you've confirmed
// quota usage. Full market key list: https://the-odds-api.com/sports-odds-data/betting-markets.html
const SPORTS_CONFIG = [
  {
    sportKey: "basketball_nba",
    sportLabel: "NBA",
    markets: ["player_points", "player_rebounds", "player_assists", "player_threes"],
  },
  // Add once NBA flow is confirmed working:
  // { sportKey: "americanfootball_nfl", sportLabel: "NFL", markets: ["player_pass_yds", "player_reception_yds", "player_receptions"] },
  // { sportKey: "baseball_mlb", sportLabel: "MLB", markets: ["batter_hits", "batter_total_bases"] },
];

// Prioritize sharp books for the "fair" side of the comparison, and pull
// PrizePicks directly as a licensed DFS data source (region: us_dfs).
// This is NOT scraping — The Odds API has an official PrizePicks feed.
// Mixing bookmakers across regions is supported: "Bookmakers can be from any region."
const SHARP_BOOKMAKERS = ["pinnacle", "fanduel", "draftkings"];
const DFS_BOOKMAKERS = ["prizepicks"];
const ALL_BOOKMAKERS = [...SHARP_BOOKMAKERS, ...DFS_BOOKMAKERS].join(",");

const STAT_LABELS = {
  player_points: "Points",
  player_rebounds: "Rebounds",
  player_assists: "Assists",
  player_threes: "3-Pointers Made",
  player_pass_yds: "Passing Yards",
  player_reception_yds: "Receiving Yards",
  player_receptions: "Receptions",
  batter_hits: "Hits",
  batter_total_bases: "Total Bases",
};

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odds API error ${res.status}: ${body}`);
  }
  return res.json();
}

async function processSport({ sportKey, sportLabel, markets }) {
  // Step 1: get upcoming events (free — doesn't count against quota)
  const eventsUrl = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${ODDS_API_KEY}`;
  const events = await fetchJSON(eventsUrl);

  let upserts = 0;

  for (const event of events) {
    // Step 2: pull player prop odds for this event (costs quota: markets x regions/bookmakers)
    const oddsUrl =
      `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${event.id}/odds` +
      `?apiKey=${ODDS_API_KEY}&bookmakers=${ALL_BOOKMAKERS}` +
      `&markets=${markets.join(",")}&oddsFormat=american`;

    let eventOdds;
    try {
      eventOdds = await fetchJSON(oddsUrl);
    } catch (err) {
      console.error(`Skipping event ${event.id} (${event.home_team} vs ${event.away_team}):`, err.message);
      continue;
    }

    for (const bookmaker of eventOdds.bookmakers || []) {
      for (const market of bookmaker.markets || []) {
        // Group outcomes by player (each player has an Over + Under pair)
        const byPlayer = {};
        for (const outcome of market.outcomes) {
          const key = outcome.description; // player name
          byPlayer[key] = byPlayer[key] || {};
          byPlayer[key][outcome.name.toLowerCase()] = outcome; // 'over' | 'under'
        }

        for (const [playerName, sides] of Object.entries(byPlayer)) {
          // Upsert the prop record (shared between PrizePicks line + sharp book odds)
          const { data: propRow, error: propErr } = await supabase
            .from("props")
            .upsert(
              {
                event_id: event.id,
                sport: sportLabel,
                player: playerName,
                stat: STAT_LABELS[market.key] || market.key,
                market_key: market.key,
                commence_time: event.commence_time,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "event_id,player,market_key" }
            )
            .select()
            .single();

          if (propErr) {
            console.error("prop upsert failed:", propErr.message);
            continue;
          }

          if (bookmaker.key === "prizepicks") {
            // PrizePicks is pick'em, not priced odds — just record the line itself.
            // Prefer the "Over" outcome's point value (the standard, non-demon/goblin line).
            const line = sides.over?.point ?? sides.under?.point;
            if (line == null) continue;

            const { error: ppErr } = await supabase.from("pp_lines").upsert(
              {
                prop_id: propRow.id,
                pp_line: line,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "prop_id" }
            );
            if (ppErr) console.error("pp_lines upsert failed:", ppErr.message);
            continue;
          }

          // Sharp sportsbook: need both sides to de-vig
          if (!sides.over || !sides.under) continue;

          const { overFairProb, underFairProb } = devigTwoWay(sides.over.price, sides.under.price);

          const { error: oddsErr } = await supabase.from("sportsbook_odds").upsert(
            {
              prop_id: propRow.id,
              bookmaker: bookmaker.key,
              line: sides.over.point,
              over_price: sides.over.price,
              under_price: sides.under.price,
              over_fair_prob: overFairProb,
              under_fair_prob: underFairProb,
              fetched_at: new Date().toISOString(),
            },
            { onConflict: "prop_id,bookmaker" }
          );

          if (oddsErr) {
            console.error("odds upsert failed:", oddsErr.message);
            continue;
          }

          upserts++;
        }
      }
    }
  }

  return upserts;
}

exports.handler = async function () {
  let totalUpserts = 0;
  const errors = [];

  for (const config of SPORTS_CONFIG) {
    try {
      totalUpserts += await processSport(config);
    } catch (err) {
      errors.push(`${config.sportLabel}: ${err.message}`);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: `Upserted ${totalUpserts} odds rows`,
      errors,
    }),
  };
};
