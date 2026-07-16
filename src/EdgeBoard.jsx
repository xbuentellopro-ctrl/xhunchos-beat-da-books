import React, { useState, useMemo, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import { TrendingUp, TrendingDown, Search, ChevronUp, ChevronDown, Zap, Loader2 } from "lucide-react";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// Real PrizePicks standard payout multipliers (verified against prizepicks.com/help-center/payouts, mid-2026)
const POWER_MULTIPLIERS = {
  2: { 2: 3.0 },
  3: { 3: 6.0 },
  4: { 4: 10.0 },
  5: { 5: 20.0 },
  6: { 6: 37.5 },
};
const FLEX_MULTIPLIERS = {
  3: { 3: 3.0, 2: 1.0 },
  4: { 4: 6.0, 3: 1.5 },
  5: { 5: 10.0, 4: 2.0, 3: 0.4 },
  6: { 6: 25.0, 5: 2.0, 4: 0.4 },
};

function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

function breakevenProb(n, payouts) {
  const ev = (p) => {
    let total = 0;
    for (const k in payouts) {
      const kk = Number(k);
      const prob = combinations(n, kk) * Math.pow(p, kk) * Math.pow(1 - p, n - kk);
      total += prob * payouts[kk];
    }
    return total - 1;
  };
  let lo = 0.01,
    hi = 0.99;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ev(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

const BREAKEVEN = { power: {}, flex: {} };
Object.entries(POWER_MULTIPLIERS).forEach(([n, payouts]) => {
  BREAKEVEN.power[n] = breakevenProb(Number(n), payouts);
});
Object.entries(FLEX_MULTIPLIERS).forEach(([n, payouts]) => {
  BREAKEVEN.flex[n] = breakevenProb(Number(n), payouts);
});

function calcEdge(bookNoVig, entrySize, playType) {
  const breakeven = BREAKEVEN[playType]?.[entrySize] ?? 0.55;
  return (bookNoVig - breakeven) * 100;
}

const SPORT_COLORS = {
  NBA: "#C9A24B",
  NFL: "#3ECF8E",
  MLB: "#7DA7D9",
  WNBA: "#E88AB5",
};

// Preference order when multiple sharp books have a line on the same prop
const BOOK_PRIORITY = ["pinnacle", "fanduel", "draftkings"];

function transformRows(rawProps) {
  const rows = [];

  for (const prop of rawProps) {
    const ppLineRaw = prop.pp_lines;
    const ppLine = Array.isArray(ppLineRaw) ? ppLineRaw[0]?.pp_line : ppLineRaw?.pp_line;
    if (ppLine == null) continue;
    if (!prop.sportsbook_odds || prop.sportsbook_odds.length === 0) continue;

    // Pick the best available sharp book by priority order
    let chosen = null;
    for (const bookKey of BOOK_PRIORITY) {
      chosen = prop.sportsbook_odds.find((o) => o.bookmaker === bookKey);
      if (chosen) break;
    }
    if (!chosen) chosen = prop.sportsbook_odds[0];

    // Pick whichever side (Over/Under) is the stronger play
    const overProb = chosen.over_fair_prob;
    const underProb = chosen.under_fair_prob;
    const side = overProb >= underProb ? "Over" : "Under";
    const bookNoVig = side === "Over" ? overProb : underProb;

    rows.push({
      id: prop.id,
      player: prop.player,
      team: prop.team || "",
      matchup: prop.matchup || "",
      sport: prop.sport,
      stat: prop.stat,
      ppLine,
      side,
      bookNoVig,
      book: chosen.bookmaker.charAt(0).toUpperCase() + chosen.bookmaker.slice(1),
    });
  }

  return rows;
}

export default function EdgeBoard() {
  const [playType, setPlayType] = useState("flex");
  const [entrySize, setEntrySize] = useState(6);
  const [sportFilter, setSportFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("edge");
  const [sortDir, setSortDir] = useState("desc");
  const [rawProps, setRawProps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadProps() {
      setLoading(true);
      setLoadError(null);

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

      const { data, error } = await supabase
        .from("props")
        .select(
          `
          id, player, team, sport, stat, matchup, commence_time,
          pp_lines ( pp_line ),
          sportsbook_odds ( bookmaker, over_fair_prob, under_fair_prob )
        `
        )
        .gte("commence_time", startOfDay.toISOString())
        .lt("commence_time", endOfDay.toISOString())
        .order("commence_time", { ascending: true })
        .limit(500);

      if (cancelled) return;

      if (error) {
        setLoadError(error.message);
        setLoading(false);
        return;
      }

      setRawProps(data || []);
      setLastFetched(new Date());
      setLoading(false);
    }

    loadProps();
    // Refresh every 5 minutes while the tab is open
    const interval = setInterval(loadProps, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const baseRows = useMemo(() => transformRows(rawProps), [rawProps]);

  const availableSizes = playType === "power" ? [2, 3, 4, 5, 6] : [3, 4, 5, 6];

  const rows = useMemo(() => {
    let data = baseRows.map((p) => ({
      ...p,
      edge: calcEdge(p.bookNoVig, entrySize, playType),
    }));

    if (sportFilter !== "ALL") data = data.filter((p) => p.sport === sportFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      data = data.filter((p) => p.player.toLowerCase().includes(q) || p.team.toLowerCase().includes(q));
    }

    data.sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];
      if (typeof av === "string") {
        av = av.toLowerCase();
        bv = bv.toLowerCase();
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });

    return data;
  }, [baseRows, entrySize, sportFilter, search, sortKey, sortDir, playType]);

  const topEdges = useMemo(
    () =>
      baseRows
        .map((p) => ({ ...p, edge: calcEdge(p.bookNoVig, entrySize, playType) }))
        .sort((a, b) => b.edge - a.edge)
        .slice(0, 8),
    [baseRows, entrySize, playType]
  );

  const handlePlayType = (type) => {
    setPlayType(type);
    if (type === "power" && ![2, 3, 4, 5, 6].includes(entrySize)) setEntrySize(2);
    if (type === "flex" && ![3, 4, 5, 6].includes(entrySize)) setEntrySize(6);
  };

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sports = ["ALL", ...Array.from(new Set(baseRows.map((p) => p.sport)))];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0A0B0D",
        color: "#EDEAE2",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        .oswald { font-family: 'Oswald', sans-serif; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        @keyframes ticker {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .spin { animation: spin 1s linear infinite; }
        .ticker-track {
          display: flex;
          width: max-content;
          animation: ticker 38s linear infinite;
        }
        .ticker-track:hover { animation-play-state: paused; }
        .led-glow-pos {
          text-shadow: 0 0 8px rgba(62,207,142,0.65), 0 0 2px rgba(62,207,142,0.9);
        }
        .led-glow-neg {
          text-shadow: 0 0 6px rgba(229,72,77,0.35);
        }
        .row-hover:hover { background: rgba(201,162,75,0.06); }
        .felt-border {
          border: 1px solid rgba(201,162,75,0.25);
        }
        ::selection { background: #C9A24B; color: #0A0B0D; }
      `}</style>

      {/* Header */}
      <header
        style={{
          borderBottom: "1px solid rgba(201,162,75,0.25)",
          background: "linear-gradient(180deg, #0E3B2E 0%, #0A0B0D 100%)",
          padding: "20px 28px 16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 6,
                background: "#C9A24B",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Zap size={19} color="#0A0B0D" strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="oswald" style={{ fontSize: 22, fontWeight: 700, letterSpacing: 1, margin: 0, textTransform: "uppercase" }}>
                XHuncho's Beat Da Books
              </h1>
              <p style={{ fontSize: 11.5, color: "#9A9689", margin: 0, letterSpacing: 0.3 }}>
                PrizePicks lines vs. sharp no-vig probability
              </p>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {["power", "flex"].map((t) => (
                <button
                  key={t}
                  onClick={() => handlePlayType(t)}
                  className="oswald"
                  style={{
                    padding: "6px 13px",
                    borderRadius: 5,
                    border: playType === t ? "1px solid #C9A24B" : "1px solid rgba(201,162,75,0.25)",
                    background: playType === t ? "rgba(201,162,75,0.15)" : "transparent",
                    color: playType === t ? "#C9A24B" : "#9A9689",
                    fontWeight: 600,
                    fontSize: 12,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  {t === "power" ? "Power Play" : "Flex Play"}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "#9A9689", textTransform: "uppercase", letterSpacing: 0.5 }}>Picks</span>
              {availableSizes.map((n) => (
                <button
                  key={n}
                  onClick={() => setEntrySize(n)}
                  className="mono"
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 5,
                    border: entrySize === n ? "1px solid #C9A24B" : "1px solid rgba(201,162,75,0.25)",
                    background: entrySize === n ? "rgba(201,162,75,0.15)" : "transparent",
                    color: entrySize === n ? "#C9A24B" : "#9A9689",
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* Ticker */}
      <div
        style={{
          borderBottom: "1px solid rgba(201,162,75,0.2)",
          background: "#0D1210",
          overflow: "hidden",
          padding: "9px 0",
          minHeight: 34,
        }}
      >
        {topEdges.length > 0 ? (
          <div className="ticker-track">
            {[...topEdges, ...topEdges].map((p, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 22px", whiteSpace: "nowrap" }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: SPORT_COLORS[p.sport] || "#9A9689",
                    display: "inline-block",
                  }}
                />
                <span className="mono" style={{ fontSize: 12.5, color: "#EDEAE2" }}>
                  {p.player} <span style={{ color: "#9A9689" }}>{p.side} {p.ppLine}</span>
                </span>
                <span
                  className={`mono ${p.edge >= 0 ? "led-glow-pos" : "led-glow-neg"}`}
                  style={{ fontSize: 12.5, fontWeight: 700, color: p.edge >= 0 ? "#3ECF8E" : "#E5484D" }}
                >
                  {p.edge >= 0 ? "+" : ""}{p.edge.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: "0 22px", fontSize: 12, color: "#6B6858" }} className="mono">
            {loading ? "Loading live props..." : "No props with both a PrizePicks line and sportsbook odds yet."}
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ padding: "20px 28px 0", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative" }}>
          <Search size={15} color="#9A9689" style={{ position: "absolute", left: 11, top: 10 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search player or team"
            className="mono"
            style={{
              background: "#12141A",
              border: "1px solid rgba(201,162,75,0.25)",
              borderRadius: 6,
              padding: "8px 12px 8px 32px",
              color: "#EDEAE2",
              fontSize: 13,
              width: 220,
              outline: "none",
            }}
          />
        </div>
        {sports.map((s) => (
          <button
            key={s}
            onClick={() => setSportFilter(s)}
            style={{
              padding: "7px 14px",
              borderRadius: 6,
              border: sportFilter === s ? "1px solid #C9A24B" : "1px solid rgba(201,162,75,0.2)",
              background: sportFilter === s ? "rgba(201,162,75,0.15)" : "transparent",
              color: sportFilter === s ? "#C9A24B" : "#9A9689",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
              letterSpacing: 0.3,
            }}
          >
            {s}
          </button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: "#6B6858", display: "flex", alignItems: "center", gap: 6 }} className="mono">
          {loading && <Loader2 size={12} className="spin" />}
          {rows.length} props · breakeven {(BREAKEVEN[playType][entrySize] * 100).toFixed(2)}% at {entrySize}-pick {playType === "power" ? "Power" : "Flex"}
          {lastFetched && ` · updated ${lastFetched.toLocaleTimeString()}`}
        </span>
      </div>

      {/* Table */}
      <div style={{ padding: "16px 28px 40px" }}>
        {loadError && (
          <div
            style={{
              background: "rgba(229,72,77,0.1)",
              border: "1px solid rgba(229,72,77,0.3)",
              borderRadius: 8,
              padding: "12px 16px",
              marginBottom: 14,
              fontSize: 13,
              color: "#E5484D",
            }}
          >
            Couldn't load live props: {loadError}
          </div>
        )}

        <div className="felt-border" style={{ borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#12141A", borderBottom: "1px solid rgba(201,162,75,0.25)" }}>
                {[
                  { key: "player", label: "Player" },
                  { key: "matchup", label: "Matchup" },
                  { key: "sport", label: "Sport" },
                  { key: "stat", label: "Prop" },
                  { key: "ppLine", label: "PP Line" },
                  { key: "side", label: "Side" },
                  { key: "bookNoVig", label: "Fair %" },
                  { key: "book", label: "Source" },
                  { key: "edge", label: "Edge" },
                ].map((col) => (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className="oswald"
                    style={{
                      padding: "12px 16px",
                      textAlign: col.key === "edge" ? "right" : "left",
                      fontSize: 11.5,
                      fontWeight: 600,
                      letterSpacing: 0.8,
                      textTransform: "uppercase",
                      color: "#9A9689",
                      cursor: "pointer",
                      userSelect: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                      {col.label}
                      {sortKey === col.key &&
                        (sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="row-hover" style={{ borderBottom: "1px solid rgba(201,162,75,0.1)" }}>
                  <td style={{ padding: "13px 16px" }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{p.player}</div>
                    {p.team && <div className="mono" style={{ fontSize: 11, color: "#6B6858" }}>{p.team}</div>}
                  </td>
                  <td className="mono" style={{ padding: "13px 16px", fontSize: 12, color: "#9A9689" }}>
                    {p.matchup}
                  </td>
                  <td style={{ padding: "13px 16px" }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: SPORT_COLORS[p.sport] || "#9A9689",
                        border: `1px solid ${(SPORT_COLORS[p.sport] || "#9A9689")}55`,
                        borderRadius: 4,
                        padding: "2px 7px",
                      }}
                    >
                      {p.sport}
                    </span>
                  </td>
                  <td style={{ padding: "13px 16px", fontSize: 13, color: "#C4C0B4" }}>{p.stat}</td>
                  <td className="mono" style={{ padding: "13px 16px", fontSize: 13.5, fontWeight: 600 }}>
                    {p.ppLine}
                  </td>
                  <td style={{ padding: "13px 16px" }}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 12,
                        fontWeight: 600,
                        color: p.side === "Over" ? "#3ECF8E" : "#E5484D",
                      }}
                    >
                      {p.side === "Over" ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                      {p.side}
                    </span>
                  </td>
                  <td className="mono" style={{ padding: "13px 16px", fontSize: 13, color: "#C4C0B4" }}>
                    {(p.bookNoVig * 100).toFixed(1)}%
                  </td>
                  <td style={{ padding: "13px 16px", fontSize: 12, color: "#6B6858" }}>{p.book}</td>
                  <td
                    className={`mono ${p.edge >= 0 ? "led-glow-pos" : "led-glow-neg"}`}
                    style={{
                      padding: "13px 16px",
                      textAlign: "right",
                      fontSize: 15,
                      fontWeight: 700,
                      color: p.edge >= 0 ? "#3ECF8E" : "#E5484D",
                    }}
                  >
                    {p.edge >= 0 ? "+" : ""}
                    {p.edge.toFixed(1)}%
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={9} style={{ padding: 32, textAlign: "center", color: "#6B6858", fontSize: 13 }}>
                    No props match these filters yet. Sharp books often post lines closer to game time —
                    check back nearer to first pitch/tip-off.
                  </td>
                </tr>
              )}
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ padding: 32, textAlign: "center", color: "#6B6858", fontSize: 13 }}>
                    Loading live props from Supabase...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p style={{ marginTop: 14, fontSize: 11.5, color: "#6B6858", lineHeight: 1.6 }}>
          Live data from The Odds API (PrizePicks lines + Pinnacle/FanDuel/DraftKings fair pricing),
          refreshed on a schedule via a Netlify function. Breakeven math uses PrizePicks' real standard
          payout multipliers run through binomial expected-value calculations. Edge = Fair % minus the
          breakeven win rate required per leg at the selected play type and entry size.
        </p>
      </div>
    </div>
  );
}
