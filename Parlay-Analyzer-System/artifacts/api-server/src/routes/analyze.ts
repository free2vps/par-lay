import { Router, type IRouter } from "express";
import { analyzeFixture, StatsEmptyError } from "../services/ai-analysis";
import { logger } from "../lib/logger";
import { supabase } from "../lib/supabase-client";

const router: IRouter = Router();

/**
 * POST /api/analyze/:fixtureId
 * Jalankan analisis baru, panggil Gemini, simpan & kembalikan hasil.
 */
router.post("/analyze/:fixtureId", async (req, res) => {
  const { fixtureId } = req.params;

  if (!fixtureId) {
    res.status(400).json({ error: "fixtureId is required" });
    return;
  }

  try {
    logger.info({ fixtureId }, "AI analysis requested");
    const result = await analyzeFixture(fixtureId);
    res.json(result);
  } catch (err) {
    if (err instanceof StatsEmptyError) {
      res.status(400).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, fixtureId }, "AI analysis failed");
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/analyze/:fixtureId
 * Ambil prediksi terakhir yang sudah tersimpan (tanpa memanggil Gemini lagi).
 */
router.get("/analyze/:fixtureId", async (req, res) => {
  const { fixtureId } = req.params;

  try {
    const { data, error } = await supabase
      .from("ai_predictions")
      .select("*")
      .eq("fixture_id", fixtureId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    if (!data) {
      res.status(404).json({ error: "No prediction found for this fixture" });
      return;
    }

    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, fixtureId }, "Failed to fetch prediction");
    res.status(500).json({ error: message });
  }
});

export default router;
