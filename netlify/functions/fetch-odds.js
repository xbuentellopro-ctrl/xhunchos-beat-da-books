// netlify/functions/fetch-odds.js
// Scheduled Netlify function — pulls player prop odds from The Odds API,
// de-vigs them, and upserts into Supabase.

const { createClient } = require("@supabase/supabase-js");
const { devigTwoWay } = require("./devig");

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// NBA is off-season (Jul-Sep). WNBA season (May-Sep) and MLB are both live right now.
const SPORTS_CONFIG = [
  {
    sportKey: "baseball_mlb",
    sportLabel: "MLB",
    markets: ["batter_hits", "batter_total_bases", "batter_home_runs"],
  },
  {
    sportKey: "basketball_wnba",
    sportLabel: "WNBA",
    markets: ["player_points", "player_rebounds", "player_assists", "player_threes"],
  },
];

const SHARP_BOOKMAKERS = ["pinnacle", "fanduel", "draftkings"];
const DFS_BOOKMAKERS = ["prizepicks"];
const ALL_BOOKMAKERS = [...SHARP_BOOKMAKERS, ...DFS_BOOKMAKERS].join(",");

const STAT_LABELS = {
  player_points: "Points",
  player_rebounds: "Rebounds",
  player_assists: "Assists",
  player_threes: "3-Pointers Made",
  batter_hits: "Hits",
  batter_total_bases: "Total Bases",
  batter_home_runs: "Home Runs",
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
  const eventsUrl = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${ODDS_API_KEY}`;
  const events = await fetchJSON(eventsUrl);

  const debug = {
    eventsFound: events.length,
    eventSample: events.slice(0, 3).map((e) => `${e.away_team} @ ${e.home_team} (${e.commence_time})`),
    bookmakersSeenPerEvent: [],
  };

  let sharpUpserts = 0;
  let ppUpserts = 0;

  for (const event of events) {
    const oddsUrl =
      `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${event.id}/odds` +
      `?apiKey=${ODDS_API_KEY}&bookmakers=${ALL_BOOKMAKERS}` +
      `&markets=${markets.join(",")}&oddsFormat=american`;

    let eventOdds;
    try {
      eventOdds = await fetchJSON(oddsUrl);
    } catch (err) {
      debug.bookmakersSeenPerEvent.push({ event: event.id, error: err.message });
      continue;
    }

    debug.bookmakersSeenPerEvent.push({
      event: `${event.away_team} @ ${event.home_team}`,
      bookmakersReturned: (eventOdds.bookmakers || []).map((b) => b.key),
    });

    for (const bookmaker of eventOdds.bookmakers || []) {
      for (const market of bookmaker.markets || []) {
        const byPlayer = {};
        for (const outcome of market.outcomes) {
          const key = outcome.description;
          byPlayer[key] = byPlayer[key] || {};
          byPlayer[key][outcome.name.toLowerCase()] = outcome;
        }

        for (const [playerName, sides] of Object.entries(byPlayer)) {
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

          if (propErr) continue;

          if (bookmaker.key === "prizepicks") {
            const line = sides.over?.point ?? sides.under?.point;
            if (line == null) continue;
            const { error: ppErr } = await supabase.from("pp_lines").upsert(
              { prop_id: propRow.id, pp_line: line, updated_at: new Date().toISOString() },
              { onConflict: "prop_id" }
            );
            if (!ppErr) ppUpserts++;
            continue;
          }

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

          if (!oddsErr) sharpUpserts++;
        }
      }
    }
  }

  return { sharpUpserts, ppUpserts, debug };
}

exports.handler = async function () {
  let totalSharp = 0;
  let totalPP = 0;
  const allDebug = [];
  const errors = [];

  for (const config of SPORTS_CONFIG) {
    try {
      const result = await processSport(config);
      totalSharp += result.sharpUpserts;
      totalPP += result.ppUpserts;
      allDebug.push({ sport: config.sportLabel, ...result.debug });
    } catch (err) {
      errors.push(`${config.sportLabel}: ${err.message}`);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: `Upserted ${totalSharp} sharp-book odds rows, ${totalPP} PrizePicks lines`,
      debug: allDebug,
      errors,
    }, null, 2),
  };
};
