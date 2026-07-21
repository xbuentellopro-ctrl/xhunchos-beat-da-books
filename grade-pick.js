const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Body: { pickId, result }  where result is 'win' | 'loss' | 'push'
// No free API reliably returns settled player-prop results across these sports,
// so grading a pick after the game is final is a manual, deliberate action --
// this keeps the record honest instead of silently guessing.
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

  const { pickId, result } = payload;
  if (!pickId || !["win", "loss", "push"].includes(result)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "pickId and result ('win'|'loss'|'push') are required" }),
    };
  }

  const { data, error } = await supabase
    .from("logged_picks")
    .update({ result, graded_at: new Date().toISOString() })
    .eq("id", pickId)
    .select()
    .single();

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ pick: data }) };
};
