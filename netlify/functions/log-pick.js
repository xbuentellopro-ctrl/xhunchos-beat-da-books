const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Body: { propId, player, team, matchup, sport, stat, marketKey, side,
//         ppLine, book, openProb, openEdge, playType, entrySize, commenceTime, notes }
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const required = [
    "player", "sport", "stat", "side", "ppLine", "book",
    "openProb", "openEdge", "playType", "entrySize", "commenceTime",
  ];
  const missing = required.filter((k) => payload[k] === undefined || payload[k] === null);
  if (missing.length) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Missing fields: ${missing.join(", ")}` }),
    };
  }

  const { data, error } = await supabase
    .from("logged_picks")
    .insert({
      prop_id: payload.propId || null,
      player: payload.player,
      team: payload.team || null,
      matchup: payload.matchup || null,
      sport: payload.sport,
      stat: payload.stat,
      market_key: payload.marketKey || null,
      side: payload.side,
      pp_line: payload.ppLine,
      book: payload.book,
      open_prob: payload.openProb,
      open_edge: payload.openEdge,
      play_type: payload.playType,
      entry_size: payload.entrySize,
      commence_time: payload.commenceTime,
      notes: payload.notes || null,
    })
    .select()
    .single();

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ pick: data }) };
};
