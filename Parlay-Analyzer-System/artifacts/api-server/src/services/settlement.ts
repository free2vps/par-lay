import { GoogleGenerativeAI } from "@google/generative-ai";
import { supabase } from "../lib/supabase-client";
import { logger } from "../lib/logger";

const BASE_URL = "https://api.odds-api.io/v3";

interface ApiCompletedEvent {
  id: number;
  home: string;
  away: string;
  date: string;
  status: string;
  result?: {
    home?: number | string;
    away?: number | string;
  };
  scores?: {
    home?: number | string;
    away?: number | string;
  };
  home_score?: number | string;
  away_score?: number | string;
}

interface PendingPrediction {
  id: string;
  fixture_id: number;
  prediction_text: string | null;
  best_market: string | null;
  home_team: string | null;
  away_team: string | null;
  expected_value: number | null;
  league: string | null;
}

/* ── Fetch completed events from odds-api.io ── */
async function fetchCompletedEvents(leagueSlug: string, apiKey: string): Promise<ApiCompletedEvent[]> {
  try {
    const params = new URLSearchParams({
      apiKey,
      sport: "football",
      league: leagueSlug,
      status: "completed",
    });
    const res = await fetch(`${BASE_URL}/events?${params}`);
    if (!res.ok) return [];
    const data = await res.json() as ApiCompletedEvent | ApiCompletedEvent[];
    return Array.isArray(data) ? data : [data];
  } catch {
    return [];
  }
}

/* ── Extract score from API response ── */
function extractScore(event: ApiCompletedEvent): { home: number | null; away: number | null } {
  const home =
    event.result?.home != null ? Number(event.result.home) :
    event.scores?.home != null ? Number(event.scores.home) :
    event.home_score != null ? Number(event.home_score) : null;

  const away =
    event.result?.away != null ? Number(event.result.away) :
    event.scores?.away != null ? Number(event.scores.away) :
    event.away_score != null ? Number(event.away_score) : null;

  return { home, away };
}

/* ── Ask Gemini to evaluate a LOSS prediction ── */
async function evaluateLossWithGemini(
  prediction: PendingPrediction,
  homeScore: number,
  awayScore: number,
  geminiKey: string,
): Promise<string | null> {
  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `Anda adalah analis evaluasi pasca-pertandingan.

Pertandingan: ${prediction.home_team} vs ${prediction.away_team}
Skor Akhir: ${homeScore} - ${awayScore}
Prediksi AI sebelumnya:
${prediction.prediction_text ?? "Tidak tersedia"}

Pertandingan ini menghasilkan hasil yang berbeda dari yang direkomendasikan.

Tugas Anda:
1. Identifikasi faktor kunci yang mungkin tidak terprediksi dengan baik (dalam 2-3 kalimat)
2. Berikan 1 pelajaran konkret yang bisa dipakai untuk analisis pertandingan serupa di masa depan
3. Format output: hanya tuliskan pelajarannya saja, tanpa intro atau header.`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    logger.warn({ err }, "Failed to get Gemini lesson evaluation");
    return null;
  }
}

/* ── Main settlement runner ── */
export async function runSettlement(): Promise<{ settled: number; lessons: number }> {
  logger.info("[SETTLEMENT] Memulai pengecekan hasil pertandingan...");

  const oddsApiKey = process.env["ODDS_API_KEY"];
  const geminiKey  = process.env["GEMINI_API_KEY"];

  if (!oddsApiKey) {
    logger.warn("[SETTLEMENT] ODDS_API_KEY tidak tersedia — skip");
    return { settled: 0, lessons: 0 };
  }

  /* 1. Ambil semua prediksi yang statusnya masih active */
  const { data: pendingPredictions, error: predErr } = await supabase
    .from("ai_predictions")
    .select("id, fixture_id, prediction_text, best_market, home_team, away_team, expected_value, league")
    .eq("status", "active")
    .not("prediction_text", "is", null)
    .limit(50);

  if (predErr || !pendingPredictions?.length) {
    logger.info("[SETTLEMENT] Tidak ada prediksi aktif untuk di-settle");
    return { settled: 0, lessons: 0 };
  }

  /* 2. Ambil fixtures yang sudah selesai dari tabel kita */
  const fixtureIds = pendingPredictions.map((p) => p.fixture_id);
  const { data: completedFixtures } = await supabase
    .from("fixtures")
    .select("fixture_id, home_team_name, away_team_name, league_name, status_short")
    .in("fixture_id", fixtureIds)
    .in("status_short", ["FT", "AET", "PEN", "finished", "completed"]);

  if (!completedFixtures?.length) {
    logger.info("[SETTLEMENT] Tidak ada fixture selesai ditemukan");
    return { settled: 0, lessons: 0 };
  }

  logger.info(`[SETTLEMENT] Ditemukan ${completedFixtures.length} fixture selesai dari ${pendingPredictions.length} prediksi aktif`);

  /* 3. Ambil konfigurasi aktif untuk tahu liga apa yang ditrack */
  const { data: cfg } = await supabase
    .from("scheduler_config")
    .select("leagues")
    .limit(1)
    .single();

  const trackedLeagues: string[] = cfg?.leagues ?? [];

  /* 4. Untuk setiap fixture selesai — cari skor dari odds-api.io */
  let settled = 0;
  let lessonsCreated = 0;

  for (const fixture of completedFixtures) {
    const prediction = pendingPredictions.find(
      (p) => p.fixture_id === fixture.fixture_id
    ) as PendingPrediction | undefined;
    if (!prediction) continue;

    /* Cari skor: coba semua liga yang kita track */
    let homeScore: number | null = null;
    let awayScore: number | null = null;

    const leagueToSearch = trackedLeagues.length > 0 ? trackedLeagues : ["england-premier-league"];
    for (const league of leagueToSearch) {
      const events = await fetchCompletedEvents(league, oddsApiKey);
      const match = events.find((e) => e.id === fixture.fixture_id);
      if (match) {
        const score = extractScore(match);
        homeScore = score.home;
        awayScore = score.away;
        break;
      }
    }

    /* Jika tidak dapat skor dari API, skip settlement tapi catat */
    if (homeScore === null || awayScore === null) {
      logger.info({
        fixtureId: fixture.fixture_id,
        home: fixture.home_team_name,
        away: fixture.away_team_name,
      }, "[SETTLEMENT] Skor tidak tersedia dari API — fixture diselesaikan tanpa skor");

      await supabase.from("ai_predictions").update({
        status: "settled_no_score",
        settled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", prediction.id);

      settled++;
      continue;
    }

    logger.info({
      fixtureId: fixture.fixture_id,
      home: fixture.home_team_name,
      away: fixture.away_team_name,
      score: `${homeScore}-${awayScore}`,
    }, "[SETTLEMENT] Memproses hasil...");

    /* 5. Tentukan WIN/LOSS berdasarkan best_market dan prediksi */
    let betResult: "WIN" | "LOSS" | null = null;
    const predText = (prediction.prediction_text ?? "").toLowerCase();
    const bestMarket = (prediction.best_market ?? "").toLowerCase();

    if (bestMarket.includes("home") || bestMarket.includes("1x2 home")) {
      betResult = homeScore > awayScore ? "WIN" : "LOSS";
    } else if (bestMarket.includes("away")) {
      betResult = awayScore > homeScore ? "WIN" : "LOSS";
    } else if (bestMarket.includes("draw")) {
      betResult = homeScore === awayScore ? "WIN" : "LOSS";
    } else if (bestMarket.includes("over") || predText.includes("over 2.5")) {
      betResult = (homeScore + awayScore) > 2 ? "WIN" : "LOSS";
    } else if (bestMarket.includes("under")) {
      betResult = (homeScore + awayScore) < 3 ? "WIN" : "LOSS";
    } else if (bestMarket.includes("btts")) {
      betResult = homeScore > 0 && awayScore > 0 ? "WIN" : "LOSS";
    } else {
      /* Fallback: cek dari prediction_text */
      if (predText.includes("**ambil**")) {
        betResult = homeScore > awayScore ? "WIN" : "LOSS";
      }
    }

    /* 6. Update ai_predictions status */
    await supabase.from("ai_predictions").update({
      status: betResult ?? "settled_manual",
      home_score: homeScore,
      away_score: awayScore,
      settled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", prediction.id);

    settled++;

    /* 7. Jika LOSS dan EV tinggi → minta Gemini evaluasi → simpan ke lessons_learned */
    const evAtBet = prediction.expected_value ?? 0;
    if (betResult === "LOSS" && geminiKey) {
      logger.info({
        fixtureId: fixture.fixture_id,
        ev: evAtBet,
      }, "[SETTLEMENT] LOSS terdeteksi — meminta evaluasi Gemini...");

      const lessonText = await evaluateLossWithGemini(prediction, homeScore, awayScore, geminiKey);

      const { error: lessonErr } = await supabase.from("lessons_learned").insert({
        fixture_id: String(fixture.fixture_id),
        home_team: prediction.home_team ?? fixture.home_team_name ?? "",
        away_team: prediction.away_team ?? fixture.away_team_name ?? "",
        league: prediction.league ?? fixture.league_name ?? "",
        bet_result: betResult,
        home_score: homeScore,
        away_score: awayScore,
        ev_at_bet: evAtBet,
        ai_prediction: prediction.prediction_text?.slice(0, 2000) ?? null,
        lesson_text: lessonText,
        market_bet: prediction.best_market ?? null,
        created_at: new Date().toISOString(),
      });

      if (!lessonErr) {
        lessonsCreated++;
        logger.info({ fixtureId: fixture.fixture_id }, "[SETTLEMENT] Pelajaran berhasil disimpan ke lessons_learned");
      }
    } else if (betResult === "WIN") {
      /* Simpan juga WIN ke lessons_learned untuk referensi positif */
      await supabase.from("lessons_learned").insert({
        fixture_id: String(fixture.fixture_id),
        home_team: prediction.home_team ?? fixture.home_team_name ?? "",
        away_team: prediction.away_team ?? fixture.away_team_name ?? "",
        league: prediction.league ?? fixture.league_name ?? "",
        bet_result: "WIN",
        home_score: homeScore,
        away_score: awayScore,
        ev_at_bet: evAtBet,
        lesson_text: `Prediksi berhasil. Skor: ${homeScore}-${awayScore}. Market: ${prediction.best_market ?? "N/A"}`,
        market_bet: prediction.best_market ?? null,
        created_at: new Date().toISOString(),
      });
    }
  }

  logger.info(`[SETTLEMENT] Selesai: ${settled} diselesaikan, ${lessonsCreated} pelajaran dibuat`);
  return { settled, lessons: lessonsCreated };
}
