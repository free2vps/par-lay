import { GoogleGenerativeAI } from "@google/generative-ai";
import { supabase } from "../lib/supabase-client";
import { logger } from "../lib/logger";

/* ═══════════════════════════════════════════════════════════════
   SYSTEM INSTRUCTION — Quant Sniper v2
   ═══════════════════════════════════════════════════════════════ */
const SYSTEM_INSTRUCTION = `Anda adalah Quant Sniper, AI Analis Kuantitatif level elit yang spesialis dalam Value Betting berbasis data.

TUGAS UTAMA: MENCARI SELISIH EXPECTED VALUE (EV)
Cara kerja:
1. Hitung Probabilitas Nyata dari 11 statistik JSONB (xG, form, BTTS%, Over%, dll.)
2. Baca Probabilitas Implisit Bandar: rumus = (1 / Odds) × 100%
   Contoh: Odds Over 2.5 = 1.85 → Prob. Implisit Bandar = 54.1%
3. Jika Prob. Nyata > Prob. Implisit Bandar → itu adalah VALUE BET yang harus diambil.
   Contoh: xG & Over 2.5 stats menunjukkan 70% kemungkinan gol tinggi, namun Bandar hanya price 54% → EV positif → AMBIL.
4. Sebaliknya jika Prob. Bandar sudah lebih tinggi dari data nyata → NO BET.

FORMAT OUTPUT WAJIB:
## 📊 Ringkasan Data Kunci
(Sebutkan 3-5 angka statistik paling relevan dari kedua tim)

## 💹 Analisis Expected Value per Pasaran
Untuk setiap pasaran yang tersedia, tampilkan:
- Prob. Nyata (dari statistik): XX%
- Prob. Implisit Bandar (dari odds): XX%
- Selisih EV: +XX% / -XX%
- Verdict: VALUE / NO VALUE

## 🎯 Rekomendasi Akhir
- Pasaran terpilih: [nama pasaran]
- Keputusan: **AMBIL** atau **NO BET**
- Odds minimum yang masih value: X.XX
- Skor Keyakinan: X/10
- Justifikasi matematis singkat (2-3 kalimat)`;

/* ═══════════════════════════════════════════════════════════════
   TIPE DATA ODDS
   ═══════════════════════════════════════════════════════════════ */
interface OddsRow {
  bookmaker: string;
  market_type: string;
  odds_1: number | null;
  odds_2: number | null;
  odds_draw: number | null;
  captured_at?: string;
}

interface MarketOdds {
  bookmaker: string;
  home?: number;
  draw?: number;
  away?: number;
  over?: number;
  under?: number;
  line?: number;
  yes?: number;
  no?: number;
  impliedProb?: Record<string, string>;
}

interface StructuredOdds {
  matchWinner: MarketOdds[];
  overUnder: MarketOdds[];
  btts: MarketOdds[];
  other: { bookmaker: string; market: string; odds_1?: number; odds_2?: number; odds_draw?: number }[];
}

/* ═══════════════════════════════════════════════════════════════
   HELPER: IMPLIED PROBABILITY
   ═══════════════════════════════════════════════════════════════ */
function impliedProb(odds: number | null | undefined): string {
  if (!odds || odds <= 0) return "N/A";
  return `${((1 / odds) * 100).toFixed(1)}%`;
}

/* ═══════════════════════════════════════════════════════════════
   EKSTRAK & STRUKTURISASI ODDS
   ═══════════════════════════════════════════════════════════════ */
function extractStructuredOdds(rows: OddsRow[]): StructuredOdds {
  const result: StructuredOdds = { matchWinner: [], overUnder: [], btts: [], other: [] };

  /* Ambil hanya baris terbaru per (bookmaker, market_type) */
  const seen = new Map<string, OddsRow>();
  for (const row of rows) {
    const key = `${row.bookmaker}::${row.market_type}`;
    if (!seen.has(key)) seen.set(key, row);
  }

  for (const row of seen.values()) {
    const mt = (row.market_type ?? "").toLowerCase();

    /* ── Match Winner / 1X2 / h2h ── */
    if (mt === "h2h" || mt === "1x2" || mt === "match_winner" || mt === "match winner") {
      result.matchWinner.push({
        bookmaker: row.bookmaker,
        home: row.odds_1 ?? undefined,
        draw: row.odds_draw ?? undefined,
        away: row.odds_2 ?? undefined,
        impliedProb: {
          home: impliedProb(row.odds_1),
          draw: impliedProb(row.odds_draw),
          away: impliedProb(row.odds_2),
        },
      });
    }
    /* ── Over/Under / Totals ── */
    else if (mt === "totals" || mt === "over_under" || mt.includes("over") || mt.includes("total")) {
      result.overUnder.push({
        bookmaker: row.bookmaker,
        over: row.odds_1 ?? undefined,
        under: row.odds_2 ?? undefined,
        impliedProb: {
          over: impliedProb(row.odds_1),
          under: impliedProb(row.odds_2),
        },
      });
    }
    /* ── BTTS / Both Teams To Score ── */
    else if (mt === "btts" || mt === "both_teams_to_score" || mt.includes("both teams")) {
      result.btts.push({
        bookmaker: row.bookmaker,
        yes: row.odds_1 ?? undefined,
        no: row.odds_2 ?? undefined,
        impliedProb: {
          yes: impliedProb(row.odds_1),
          no: impliedProb(row.odds_2),
        },
      });
    }
    /* ── Pasaran Lainnya ── */
    else {
      result.other.push({
        bookmaker: row.bookmaker,
        market: row.market_type,
        odds_1: row.odds_1 ?? undefined,
        odds_2: row.odds_2 ?? undefined,
        odds_draw: row.odds_draw ?? undefined,
      });
    }
  }

  return result;
}

/* ═══════════════════════════════════════════════════════════════
   FORMAT BLOK ODDS UNTUK PROMPT
   ═══════════════════════════════════════════════════════════════ */
function formatOddsBlock(homeTeam: string, awayTeam: string, odds: StructuredOdds): string {
  const lines: string[] = ["--- DATA HARGA PASAR (ODDS BANDAR) ---"];

  /* Match Winner */
  if (odds.matchWinner.length > 0) {
    lines.push(`\n▪ Match Winner / 1X2 (${homeTeam} | Draw | ${awayTeam}):`);
    for (const o of odds.matchWinner) {
      lines.push(
        `  [${o.bookmaker}]  Home: ${o.home ?? "N/A"} (impl. ${o.impliedProb?.home})` +
        `  |  Draw: ${o.draw ?? "N/A"} (impl. ${o.impliedProb?.draw})` +
        `  |  Away: ${o.away ?? "N/A"} (impl. ${o.impliedProb?.away})`,
      );
    }
  } else {
    lines.push(`\n▪ Match Winner / 1X2: Tidak ada data odds tersedia.`);
  }

  /* Over/Under */
  if (odds.overUnder.length > 0) {
    lines.push(`\n▪ Over/Under Goals (Totals):`);
    for (const o of odds.overUnder) {
      lines.push(
        `  [${o.bookmaker}]  Over: ${o.over ?? "N/A"} (impl. ${o.impliedProb?.over})` +
        `  |  Under: ${o.under ?? "N/A"} (impl. ${o.impliedProb?.under})`,
      );
    }
  } else {
    lines.push(`\n▪ Over/Under Goals (Totals): Tidak ada data odds tersedia.`);
  }

  /* BTTS */
  if (odds.btts.length > 0) {
    lines.push(`\n▪ Both Teams to Score (BTTS):`);
    for (const o of odds.btts) {
      lines.push(
        `  [${o.bookmaker}]  Yes: ${o.yes ?? "N/A"} (impl. ${o.impliedProb?.yes})` +
        `  |  No: ${o.no ?? "N/A"} (impl. ${o.impliedProb?.no})`,
      );
    }
  } else {
    lines.push(`\n▪ Both Teams to Score (BTTS): Tidak ada data odds tersedia.`);
  }

  /* Pasaran lain */
  if (odds.other.length > 0) {
    lines.push(`\n▪ Pasaran Lainnya:`);
    for (const o of odds.other) {
      lines.push(
        `  [${o.bookmaker}] ${o.market}: ` +
        `${o.odds_1 != null ? `O1=${o.odds_1}` : ""}` +
        `${o.odds_draw != null ? ` Draw=${o.odds_draw}` : ""}` +
        `${o.odds_2 != null ? ` O2=${o.odds_2}` : ""}`.trim(),
      );
    }
  }

  return lines.join("\n");
}

/* ═══════════════════════════════════════════════════════════════
   BUILD FULL PROMPT
   ═══════════════════════════════════════════════════════════════ */
function buildPrompt(
  homeTeam: string,
  awayTeam: string,
  oddsBlock: string,
  homeStats: Record<string, unknown>,
  awayStats: Record<string, unknown>,
): string {
  return `PERTANDINGAN: ${homeTeam} vs ${awayTeam}

${oddsBlock}

--- STATISTIK ${homeTeam} (HOME) ---
1. xG (xG, xGA, xGD, GF, GA): ${JSON.stringify(homeStats.stats_xg)}
2. Failed to Score (xFTS, Home/Away %): ${JSON.stringify(homeStats.stats_fts)}
3. BTTS (BTTS %, Home/Away %): ${JSON.stringify(homeStats.stats_btts)}
4. Goal Conceded (Per Match, Home/Away): ${JSON.stringify(homeStats.stats_goals_conceded)}
5. Goal Scored (Per Match, Home/Away): ${JSON.stringify(homeStats.stats_goals_scored)}
6. Shots (Over 10.5 hingga 15.5): ${JSON.stringify(homeStats.stats_shots)}
7. Over 2.5 (% Home/Away): ${JSON.stringify(homeStats.stats_over_25)}
8. Over 3.5 (% Home/Away): ${JSON.stringify(homeStats.stats_over_35)}
9. Under (0.5 hingga 5.5): ${JSON.stringify(homeStats.stats_under)}
10. Team Form (MP, W, D, L, Last 6, PPG): ${JSON.stringify(homeStats.stats_team_form)}
11. HT Win/Loss (Win/Draw/Loss %): ${JSON.stringify(homeStats.stats_ht)}

--- STATISTIK ${awayTeam} (AWAY) ---
1. xG (xG, xGA, xGD, GF, GA): ${JSON.stringify(awayStats.stats_xg)}
2. Failed to Score (xFTS, Home/Away %): ${JSON.stringify(awayStats.stats_fts)}
3. BTTS (BTTS %, Home/Away %): ${JSON.stringify(awayStats.stats_btts)}
4. Goal Conceded (Per Match, Home/Away): ${JSON.stringify(awayStats.stats_goals_conceded)}
5. Goal Scored (Per Match, Home/Away): ${JSON.stringify(awayStats.stats_goals_scored)}
6. Shots (Over 10.5 hingga 15.5): ${JSON.stringify(awayStats.stats_shots)}
7. Over 2.5 (% Home/Away): ${JSON.stringify(awayStats.stats_over_25)}
8. Over 3.5 (% Home/Away): ${JSON.stringify(awayStats.stats_over_35)}
9. Under (0.5 hingga 5.5): ${JSON.stringify(awayStats.stats_under)}
10. Team Form (MP, W, D, L, Last 6, PPG): ${JSON.stringify(awayStats.stats_team_form)}
11. HT Win/Loss (Win/Draw/Loss %): ${JSON.stringify(awayStats.stats_ht)}`;
}

/* ═══════════════════════════════════════════════════════════════
   HELPER
   ═══════════════════════════════════════════════════════════════ */
function hasStats(stats: Record<string, unknown>): boolean {
  return Object.values(stats).some((v) => v !== null && v !== undefined);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORTS
   ═══════════════════════════════════════════════════════════════ */
export interface AnalysisResult {
  fixture_id: string;
  home_team: string;
  away_team: string;
  prediction_text: string;
  created_at: string;
}

export class StatsEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsEmptyError";
  }
}

/* ═══════════════════════════════════════════════════════════════
   MAIN: analyzeFixture
   ═══════════════════════════════════════════════════════════════ */
export async function analyzeFixture(fixtureId: string): Promise<AnalysisResult> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  if (!supabase) throw new Error("Supabase client not initialised");

  /* ── 1. Fetch fixture ── */
  const { data: fixture, error: fixtureError } = await supabase
    .from("fixtures")
    .select("*")
    .eq("fixture_id", fixtureId)
    .single();

  if (fixtureError || !fixture) {
    throw new Error(`Fixture not found: ${fixtureError?.message ?? "no data"}`);
  }

  const homeTeam: string = fixture.home_team ?? fixture.home_name ?? fixture.home_team_name ?? fixture.team_home ?? "";
  const awayTeam: string = fixture.away_team ?? fixture.away_name ?? fixture.away_team_name ?? fixture.team_away ?? "";

  if (!homeTeam || !awayTeam) {
    throw new Error("Fixture record is missing home_team or away_team fields");
  }

  /* ── 2. Fetch & parse odds ── */
  const { data: oddsRows } = await supabase
    .from("odds_history")
    .select("bookmaker, market_type, odds_1, odds_2, odds_draw, captured_at")
    .eq("match_id", fixtureId)
    .order("captured_at", { ascending: false })
    .limit(60);

  const structuredOdds = extractStructuredOdds((oddsRows ?? []) as OddsRow[]);
  const oddsBlock = formatOddsBlock(homeTeam, awayTeam, structuredOdds);

  /* ── 3. Fetch team stats ── */
  const STAT_COLS = "stats_xg, stats_fts, stats_btts, stats_goals_conceded, stats_goals_scored, stats_shots, stats_over_25, stats_over_35, stats_under, stats_team_form, stats_ht";

  const fetchStats = async (teamName: string): Promise<Record<string, unknown>> => {
    const { data, error } = await supabase
      .from("team_season_stats")
      .select(STAT_COLS)
      .ilike("team_name", teamName)
      .limit(1)
      .maybeSingle();

    if (error) logger.warn({ error, teamName }, "Exact stats lookup failed, trying partial match");
    if (data) return data as Record<string, unknown>;

    const { data: partial } = await supabase
      .from("team_season_stats")
      .select(STAT_COLS)
      .ilike("team_name", `%${teamName.split(" ")[0]}%`)
      .limit(1)
      .maybeSingle();

    return (partial ?? {}) as Record<string, unknown>;
  };

  const [homeStats, awayStats] = await Promise.all([fetchStats(homeTeam), fetchStats(awayTeam)]);

  /* ── Terminal monitoring ── */
  const STAT_KEYS = ["stats_xg","stats_fts","stats_btts","stats_goals_conceded","stats_goals_scored","stats_shots","stats_over_25","stats_over_35","stats_under","stats_team_form","stats_ht"] as const;
  console.log(`\n[AI-ANALYSIS] ════════════════════════════════`);
  console.log(`[AI-ANALYSIS] Fixture: ${homeTeam} vs ${awayTeam} (ID: ${fixtureId})`);
  console.log(`[AI-ANALYSIS] Odds tersedia — 1X2: ${structuredOdds.matchWinner.length} buku | O/U: ${structuredOdds.overUnder.length} buku | BTTS: ${structuredOdds.btts.length} buku | Lain: ${structuredOdds.other.length}`);
  console.log(`[AI-ANALYSIS] Status JSONB statistik:`);
  for (const key of STAT_KEYS) {
    const label = key.replace("stats_", "").padEnd(18);
    console.log(`  ${label}  Home: ${homeStats[key] != null ? "✓ Ada" : "✗ Kosong"}  |  Away: ${awayStats[key] != null ? "✓ Ada" : "✗ Kosong"}`);
  }

  /* ── Guard: tolak jika statistik kosong ── */
  const homeHasData = hasStats(homeStats);
  const awayHasData = hasStats(awayStats);

  if (!homeHasData && !awayHasData) {
    console.log(`[AI-ANALYSIS] DITOLAK — tidak ada data statistik untuk kedua tim.\n`);
    throw new StatsEmptyError("Data statistik belum lengkap di Supabase. Silakan upload CSV terlebih dahulu.");
  }

  if (!homeHasData || !awayHasData) {
    console.log(`[AI-ANALYSIS] PERINGATAN — data ${!homeHasData ? homeTeam : awayTeam} tidak ditemukan, melanjutkan parsial.`);
  }

  console.log(`[AI-ANALYSIS] Mengirim prompt ke Gemini (gemini-2.0-flash)...\n`);
  logger.info({ fixtureId, homeTeam, awayTeam }, "Calling Gemini for analysis");

  /* ── 4. Call Gemini ── */
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: SYSTEM_INSTRUCTION,
  });

  const promptText = buildPrompt(homeTeam, awayTeam, oddsBlock, homeStats, awayStats);
  const geminiResult = await model.generateContent(promptText);
  const predictionText = geminiResult.response.text();

  console.log(`[AI-ANALYSIS] Respons Gemini diterima (${predictionText.length} karakter).`);

  /* ── 5. Simpan ke Supabase ── */
  const { error: insertError } = await supabase.from("ai_predictions").insert({
    fixture_id: fixtureId,
    prediction_text: predictionText,
    created_at: new Date().toISOString(),
  });

  if (insertError) {
    logger.warn({ insertError }, "Failed to save prediction — returning result anyway");
  }

  return {
    fixture_id: fixtureId,
    home_team: homeTeam,
    away_team: awayTeam,
    prediction_text: predictionText,
    created_at: new Date().toISOString(),
  };
}
