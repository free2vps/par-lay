import { Router, type IRouter } from "express";
import { analyzeFixture } from "../services/ai-analysis";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * POST /api/analyze/:fixtureId
 *
 * Fetches fixture + odds + team stats, calls Gemini 1.5 Pro,
 * saves the prediction to ai_predictions, and returns the result.
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
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, fixtureId }, "AI analysis failed");
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/analyze/:fixtureId
 *
 * Retrieve the most recent saved prediction for a fixture
 * without re-running the AI call.
 */
router.get("/analyze/:fixtureId", async (req, res) => {
  const { fixtureId } = req.params;

  try {
    const { supabase } = await import("../lib/supabase-client");
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
