const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const BOOK_PRIORITY = ["pinnacle", "fanduel", "draftkings"];

// For every logged pick whose game has started (or is starting soon) and that
// doesn't have a closing line captured yet, grab the freshest sharp-book fair
// probability we currently have for that prop and record it as the closing line.
// This must run BEFORE fetch-odds's cleanup step deletes props/odds for games
// that already started, or there'll be nothing left to read.
async function captureClosingLines() {
  const now = new Date().toISOString();

  const { data: pending, error: pendingErr } = await supabase
    .from("logged_picks")
    .select("id, prop_id, side")
    .is("closing_prob", null)
    .lte("commence_time", now);

  if (pendingErr) return { captured: 0, error: pendingErr.message };
  if (!pending || pending.length === 0) return { captured: 0, error: null };

  let captured = 0;
  const errors = [];

  for (const pick of pending) {
    if (!pick.prop_id) continue;

    const { data: oddsRows, error: oddsErr } = await supabase
      .from("sportsbook_odds")
      .select("bookmaker, over_fair_prob, under_fair_prob, fetched_at")
      .eq("prop_id", pick.prop_id);

    if (oddsErr || !oddsRows || oddsRows.length === 0) continue;

    let chosen = null;
    for (const bookKey of BOOK_PRIORITY) {
      chosen = oddsRows.find((o) => o.bookmaker === bookKey);
      if (chosen) break;
    }
    if (!chosen) chosen = oddsRows[0];

    const closingProb = pick.side === "Over" ? chosen.over_fair_prob : chosen.under_fair_prob;
    if (closingProb == null) continue;

    const { data: openPick } = await supabase
      .from("logged_picks")
      .select("open_prob")
      .eq("id", pick.id)
      .single();

    const clv = openPick ? closingProb - openPick.open_prob : null;

    const { error: updateErr } = await supabase
      .from("logged_picks")
      .update({
        closing_prob: closingProb,
        closing_book: chosen.bookmaker,
        closing_captured_at: new Date().toISOString(),
        clv,
      })
      .eq("id", pick.id);

    if (updateErr) {
      errors.push(updateErr.message);
    } else {
      captured++;
    }
  }

  return { captured, error: errors.length ? errors.slice(0, 3).join("; ") : null };
}

exports.handler = async function () {
  const result = await captureClosingLines();
  return { statusCode: 200, body: JSON.stringify(result) };
};

module.exports.captureClosingLines = captureClosingLines;
