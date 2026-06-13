import { GoogleGenerativeAI } from "@google/generative-ai";
import { supabase } from "../lib/supabase-client";
import { logger } from "../lib/logger";

const SYSTEM_INSTRUCTION = `Anda adalah Quant Sniper, AI Analis Kuantitatif level elit. Tujuan Anda mencari profit melalui Value Betting. Bandingkan Probabilitas Asli (dari 11 data statistik di atas) melawan Probabilitas Bandar (Odds). Analisis secara mendalam pasaran yang paling menguntungkan (apakah 1X2, Over/Under, Shots, atau BTTS). Berikan rekomendasi akhir: AMBIL atau NO BET, beserta justifikasi matematis. Berikan skor keyakinan 1-10.`;

function buildPrompt(
  homeTeam: string,
  awayTeam: string,
  oddsData: unknown,
  homeStats: Record<string, unknown>,
  awayStats: Record<string, unknown>,
): string {
  return `Pertandingan: ${homeTeam} vs ${awayTeam}.
Data Odds Bandar: ${JSON.stringify(oddsData)}

--- STATISTIK ${homeTeam} ---
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

--- STATISTIK ${awayTeam} ---
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

export interface AnalysisResult {
  fixture_id: string;
  home_team: string;
  away_team: string;
  prediction_text: string;
  created_at: string;
}

export async function analyzeFixture(fixtureId: string): Promise<AnalysisResult> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  if (!supabase) {
    throw new Error("Supabase client is not initialised — check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }

  /* ── 1. Fetch fixture ── */
  const { data: fixture, error: fixtureError } = await supabase
    .from("fixtures")
    .select("*")
    .eq("fixture_id", fixtureId)
    .single();

  if (fixtureError || !fixture) {
    throw new Error(`Fixture not found: ${fixtureError?.message ?? "no data"}`);
  }

  const homeTeam: string = fixture.home_team ?? fixture.home_name ?? fixture.team_home ?? "";
  const awayTeam: string = fixture.away_team ?? fixture.away_name ?? fixture.team_away ?? "";

  if (!homeTeam || !awayTeam) {
    throw new Error("Fixture record is missing home_team or away_team fields");
  }

  /* ── 2. Fetch odds for this fixture ── */
  const { data: oddsRows } = await supabase
    .from("odds_history")
    .select("*")
    .eq("match_id", fixtureId)
    .order("captured_at", { ascending: false })
    .limit(20);

  const oddsData = oddsRows ?? [];

  /* ── 3. Fetch team stats (case-insensitive, partial match fallback) ── */
  const fetchStats = async (teamName: string) => {
    const { data, error } = await supabase
      .from("team_season_stats")
      .select(
        "stats_xg, stats_fts, stats_btts, stats_goals_conceded, stats_goals_scored, stats_shots, stats_over_25, stats_over_35, stats_under, stats_team_form, stats_ht",
      )
      .ilike("team_name", teamName)
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.warn({ error, teamName }, "Exact team stats lookup failed, trying partial match");
    }

    if (data) return data;

    /* Partial match fallback */
    const { data: partial } = await supabase
      .from("team_season_stats")
      .select(
        "stats_xg, stats_fts, stats_btts, stats_goals_conceded, stats_goals_scored, stats_shots, stats_over_25, stats_over_35, stats_under, stats_team_form, stats_ht",
      )
      .ilike("team_name", `%${teamName.split(" ")[0]}%`)
      .limit(1)
      .maybeSingle();

    return partial ?? {};
  };

  const [homeStats, awayStats] = await Promise.all([
    fetchStats(homeTeam),
    fetchStats(awayTeam),
  ]);

  logger.info({ fixtureId, homeTeam, awayTeam }, "Sending data to Gemini for analysis");

  /* ── 4. Call Gemini ── */
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-pro",
    systemInstruction: SYSTEM_INSTRUCTION,
  });

  const promptText = buildPrompt(homeTeam, awayTeam, oddsData, homeStats, awayStats);

  const result = await model.generateContent(promptText);
  const predictionText = result.response.text();

  /* ── 5. Persist to Supabase ── */
  const { error: insertError } = await supabase.from("ai_predictions").insert({
    fixture_id: fixtureId,
    prediction_text: predictionText,
    created_at: new Date().toISOString(),
  });

  if (insertError) {
    logger.warn({ insertError }, "Failed to save prediction to ai_predictions table — returning result anyway");
  }

  return {
    fixture_id: fixtureId,
    home_team: homeTeam,
    away_team: awayTeam,
    prediction_text: predictionText,
    created_at: new Date().toISOString(),
  };
}
