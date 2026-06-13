import cron from "node-cron";
import { logger } from "../lib/logger";
import { fetchAndSaveAllLeagues, DEFAULT_LEAGUES, type LeagueConfig } from "../services/odds-fetcher";
import { supabase } from "../lib/supabase-client";

let currentTask: ReturnType<typeof cron.schedule> | null = null;

async function loadConfigAndSync() {
  let leagues: LeagueConfig[] = DEFAULT_LEAGUES;
  let bookmakers = "Bet365,Sbobet";
  try {
    const { data, error } = await supabase
      .from("scheduler_config")
      .select("*")
      .limit(1);
    if (error) throw error;
    const cfg = data?.[0];
    if (cfg) {
      if (cfg.leagues.length > 0) {
        leagues = DEFAULT_LEAGUES.filter((l) => cfg.leagues.includes(l.slug));
        if (leagues.length === 0) leagues = DEFAULT_LEAGUES;
      }
      if (cfg.bookmakers.length > 0) {
        bookmakers = cfg.bookmakers.join(",");
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to load scheduler config — using defaults");
  }
  logger.info(
    { leagues: leagues.map((l) => l.slug), bookmakers },
    "Cron triggered: odds sync",
  );
  await fetchAndSaveAllLeagues(leagues, bookmakers);
}

export function startScheduler() {
  logger.info("Scheduler starting");

  loadConfigAndSync().catch((err) =>
    logger.error({ err }, "Initial odds sync failed"),
  );

  if (currentTask) {
    currentTask.stop();
  }

  currentTask = cron.schedule("0 */3 * * *", () => {
    loadConfigAndSync().catch((err) =>
      logger.error({ err }, "Scheduled odds sync failed"),
    );
  });

  logger.info("Scheduler running — odds sync every 3 hours");
}
