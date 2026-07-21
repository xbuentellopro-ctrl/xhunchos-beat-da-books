import React, { useEffect, useState, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import { TrendingUp, TrendingDown, Loader2, Check, X, Minus } from "lucide-react";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

const SPORT_COLORS = {
  NBA: "#C9A24B",
  NFL: "#3ECF8E",
  MLB: "#7DA7D9",
  WNBA: "#E88AB5",
};

async function gradePick(pickId, result) {
  const res = await fetch("/.netlify/functions/grade-pick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pickId, result }),
  });
  if (!res.ok) throw new Error("Grade failed");
  return res.json();
}

export default function MyPicks() {
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [gradingId, setGradingId] = useState(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await supabase
      .from("logged_picks")
      .select("*")
      .order("logged_at", { ascending: false })
      .limit(500);

    if (error) {
      setLoadError(error.message);
      setLoading(false);
      return;
    }
    setPicks(data || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const handleGrade = async (pickId, result) => {
    setGradingId(pickId);
    try {
      await gradePick(pickId, result);
      await load();
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setGradingId(null);
    }
  };

  const stats = useMemo(() => {
    const graded = picks.filter((p) => p.result);
    const wins = graded.filter((p) => p.result === "win").length;
    const losses = graded.filter((p) => p.result === "loss").length;
    const pushes = graded.filter((p) => p.result === "push").length;
    const decided = wins + losses;
    const winRate = decided > 0 ? (wins / decided) * 100 : null;

    const withClv = picks.filter((p) => p.clv != null);
    const avgClv =
      withClv.length > 0 ? (withClv.reduce((s, p) => s + p.clv, 0) / withClv.length) * 100 : null;
    const positiveClvPct =
      withClv.length > 0
        ? (withClv.filter((p) => p.clv > 0).length / withClv.length) * 100
        : null;

    return { total: picks.length, wins, losses, pushes, winRate, avgClv, positiveClvPct, withClvCount: withClv.length };
  }, [picks]);

  return (
    <div style={{ padding: "20px 28px 40px" }}>
      {/* Summary */}
      <div
        className="felt-border"
        style={{
          borderRadius: 10,
          padding: "16px 20px",
          marginBottom: 18,
          display: "flex",
          gap: 32,
          flexWrap: "wrap",
        }}
      >
        <Stat label="Logged Picks" value={stats.total} />
        <Stat
          label="Record (W-L-P)"
          value={`${stats.wins}-${stats.losses}-${stats.pushes}`}
        />
        <Stat
          label="Win Rate"
          value={stats.winRate != null ? `${stats.winRate.toFixed(1)}%` : "—"}
          color={stats.winRate != null ? (stats.winRate >= 50 ? "#3ECF8E" : "#E5484D") : undefined}
        />
        <Stat
          label="Avg CLV"
          value={stats.avgClv != null ? `${stats.avgClv >= 0 ? "+" : ""}${stats.avgClv.toFixed(2)}pt` : "—"}
          color={stats.avgClv != null ? (stats.avgClv >= 0 ? "#3ECF8E" : "#E5484D") : undefined}
          hint="closing fair % minus your fair % at pick time — the honest skill signal"
        />
        <Stat
          label="Beat Closing Line"
          value={stats.positiveClvPct != null ? `${stats.positiveClvPct.toFixed(0)}%` : "—"}
          hint={`of ${stats.withClvCount} picks with a captured closing line`}
        />
      </div>

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
          {loadError}
        </div>
      )}

      <div className="felt-border" style={{ borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#12141A", borderBottom: "1px solid rgba(201,162,75,0.25)" }}>
              {["Logged", "Player", "Matchup", "Sport", "Prop", "Pick", "Open %", "Close %", "CLV", "Edge", "Result"].map(
                (label) => (
                  <th
                    key={label}
                    className="oswald"
                    style={{
                      padding: "12px 14px",
                      textAlign: "left",
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: 0.8,
                      textTransform: "uppercase",
                      color: "#9A9689",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {label}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {picks.map((p) => (
              <tr key={p.id} className="row-hover" style={{ borderBottom: "1px solid rgba(201,162,75,0.1)" }}>
                <td className="mono" style={{ padding: "12px 14px", fontSize: 11.5, color: "#6B6858" }}>
                  {new Date(p.logged_at).toLocaleDateString()}
                </td>
                <td style={{ padding: "12px 14px", fontWeight: 600, fontSize: 13 }}>{p.player}</td>
                <td className="mono" style={{ padding: "12px 14px", fontSize: 11.5, color: "#9A9689" }}>
                  {p.matchup}
                </td>
                <td style={{ padding: "12px 14px" }}>
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
                <td style={{ padding: "12px 14px", fontSize: 12.5, color: "#C4C0B4" }}>{p.stat}</td>
                <td style={{ padding: "12px 14px" }}>
                  <span
                    className="mono"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      color: p.side === "Over" ? "#3ECF8E" : "#E5484D",
                    }}
                  >
                    {p.side === "Over" ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    {p.side} {p.pp_line}
                  </span>
                </td>
                <td className="mono" style={{ padding: "12px 14px", fontSize: 12.5 }}>
                  {(p.open_prob * 100).toFixed(1)}%
                </td>
                <td className="mono" style={{ padding: "12px 14px", fontSize: 12.5, color: "#9A9689" }}>
                  {p.closing_prob != null ? `${(p.closing_prob * 100).toFixed(1)}%` : "pending"}
                </td>
                <td
                  className="mono"
                  style={{
                    padding: "12px 14px",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: p.clv == null ? "#6B6858" : p.clv >= 0 ? "#3ECF8E" : "#E5484D",
                  }}
                >
                  {p.clv != null ? `${p.clv >= 0 ? "+" : ""}${(p.clv * 100).toFixed(2)}` : "—"}
                </td>
                <td
                  className="mono"
                  style={{
                    padding: "12px 14px",
                    fontSize: 13,
                    fontWeight: 700,
                    color: p.open_edge >= 0 ? "#3ECF8E" : "#E5484D",
                  }}
                >
                  {p.open_edge >= 0 ? "+" : ""}
                  {p.open_edge.toFixed(1)}%
                </td>
                <td style={{ padding: "12px 14px" }}>
                  {p.result ? (
                    <ResultBadge result={p.result} />
                  ) : (
                    <div style={{ display: "flex", gap: 4 }}>
                      <GradeButton
                        icon={<Check size={12} />}
                        color="#3ECF8E"
                        disabled={gradingId === p.id}
                        onClick={() => handleGrade(p.id, "win")}
                      />
                      <GradeButton
                        icon={<X size={12} />}
                        color="#E5484D"
                        disabled={gradingId === p.id}
                        onClick={() => handleGrade(p.id, "loss")}
                      />
                      <GradeButton
                        icon={<Minus size={12} />}
                        color="#9A9689"
                        disabled={gradingId === p.id}
                        onClick={() => handleGrade(p.id, "push")}
                      />
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {picks.length === 0 && !loading && (
              <tr>
                <td colSpan={11} style={{ padding: 32, textAlign: "center", color: "#6B6858", fontSize: 13 }}>
                  No picks logged yet. Hit "Log" on a row in the board to start your track record.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={11} style={{ padding: 32, textAlign: "center", color: "#6B6858", fontSize: 13 }}>
                  <Loader2 size={14} className="spin" style={{ verticalAlign: "middle", marginRight: 6 }} />
                  Loading logged picks...
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 14, fontSize: 11.5, color: "#6B6858", lineHeight: 1.6 }}>
        Every pick is snapshotted the moment you log it — line, fair %, and edge can't be
        edited after the fact. Closing line is captured automatically once the game starts
        (hourly check). Win/Loss/Push is entered manually since no free data source reliably
        settles player props across these sports.
      </p>
    </div>
  );
}

function Stat({ label, value, color, hint }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "#6B6858", textTransform: "uppercase", letterSpacing: 0.6 }}>
        {label}
      </div>
      <div className="mono oswald" style={{ fontSize: 20, fontWeight: 700, color: color || "#EDEAE2", marginTop: 2 }}>
        {value}
      </div>
      {hint && <div style={{ fontSize: 10, color: "#6B6858", marginTop: 2, maxWidth: 160 }}>{hint}</div>}
    </div>
  );
}

function GradeButton({ icon, color, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 24,
        height: 24,
        borderRadius: 4,
        border: `1px solid ${color}55`,
        background: "transparent",
        color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon}
    </button>
  );
}

function ResultBadge({ result }) {
  const config = {
    win: { color: "#3ECF8E", label: "WIN" },
    loss: { color: "#E5484D", label: "LOSS" },
    push: { color: "#9A9689", label: "PUSH" },
  }[result];

  return (
    <span
      className="mono"
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: config.color,
        border: `1px solid ${config.color}55`,
        borderRadius: 4,
        padding: "2px 8px",
      }}
    >
      {config.label}
    </span>
  );
}
