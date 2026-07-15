const { createClient } = require("@supabase/supabase-js");
const { devigTwoWay } = require("./devig");

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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

async function processEvent(event, sportKey, sportLabel, markets) {
  const oddsUrl =
    `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${event.id}/odds` +
    `?apiKey=${ODDS_API_KEY}&bookmakers=${ALL_BOOKMAKERS}` +
    `&markets=${markets.join(",")}&oddsFormat=american`;

  let eventOdds;
  try {
    eventOdds = await fetchJSON(oddsUrl);
  } catch (err) {
    return { sharpUpserts: 0, ppUpserts: 0, error: err.message };
  }

  let sharpUpserts = 0;
  let ppUpserts = 0;

  const propWrites = [];

  for (const bookmaker of eventOdds.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      const byPlayer = {};
      for (const outcome of market.outcomes) {
        const key = outcome.description;
        byPlayer[key] = byPlayer[key] || {};
        byPlayer[key][outcome.name.toLowerCase()] = outcome;
      }

      for (const [playerName, sides] of Object.entries(byPlayer)) {
        propWrites.push(
          (async () => {
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

            if (propErr) return;

            if (bookmaker.key === "prizepicks") {
              const line = sides.over?.point ?? sides.under?.point;
              if (line == null) return;
              const { error: ppErr } = await supabase.from("pp_lines").upsert(
                { prop_id: propRow.id, pp_line: line, updated_at: new Date().toISOString() },
                { onConflict: "prop_id" }
              );
              if (!ppErr) ppUpserts++;
              return;
            }

            if (!sides.over || !sides.under) return;

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
          })()
        );
      }
    }
  }

  await Promise.all(propWrites);

  return {
    sharpUpserts,
    ppUpserts,
    bookmakersReturned: (eventOdds.bookmakers || []).map((b) => b.key),
  };
}

async function processSport({ sportKey, sportLabel, markets }) {
  const eventsUrl = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${ODDS_API_KEY}`;
  const events = await fetchJSON(eventsUrl);

  const results = await Promise.all(
    events.map((event) => processEvent(event, sportKey, sportLabel, markets))
  );

  const sharpUpserts = results.reduce((sum, r) => sum + (r.sharpUpserts || 0), 0);
  const ppUpserts = results.reduce((sum, r) => sum + (r.ppUpserts || 0), 0);

  return {
    sharpUpserts,
    ppUpserts,
    debug: {
      eventsFound: events.length,
      eventSample: events.slice(0, 3).map((e) => `${e.away_team} @ ${e.home_team}`),
    },
  };
}

exports.handler = async function () {
  let totalSharp = 0;
  let totalPP = 0;
  const allDebug = [];
  const errors = [];

  const results = await Promise.allSettled(SPORTS_CONFIG.map((c) => processSport(c)));

  results.forEach((result, i) => {
    const sportLabel = SPORTS_CONFIG[i].sportLabel;
    if (result.status === "fulfilled") {
      totalSharp += result.value.sharpUpserts;
      totalPP += result.value.ppUpserts;
      allDebug.push({ sport: sportLabel, ...result.value.debug });
    } else {
      errors.push(`${sportLabel}: ${result.reason.message}`);
    }
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: `Upserted ${totalSharp} sharp-book odds rows, ${totalPP} PrizePicks lines`,
      debug: allDebug,
      errors,
    }, null, 2),
  };
};
