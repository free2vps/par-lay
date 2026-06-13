import { logger } from "../lib/logger";
import { supabase } from "../lib/supabase-client";

const BASE_URL = "https://api.odds-api.io/v3";

let syncRunning = false;
export function isSyncRunning(): boolean { return syncRunning; }

export interface LeagueConfig {
  slug: string;
  name: string;
}

export const DEFAULT_LEAGUES: LeagueConfig[] = [
  { slug: "england-premier-league", name: "Premier League (EPL)" },
  { slug: "england-championship", name: "Championship" },
  { slug: "spain-laliga", name: "La Liga" },
  { slug: "italy-serie-a", name: "Serie A" },
  { slug: "france-ligue-1", name: "Ligue 1" },
  { slug: "netherlands-eredivisie", name: "Eredivisie" },
  { slug: "germany-bundesliga", name: "Bundesliga" },
  { slug: "republic-of-korea-k-league-1", name: "K-League 1" },
  { slug: "china-chinese-super-league", name: "Chinese Super League" },
  { slug: "japan-j1-league", name: "J1 League (Japan)" },
];

export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`Rate limited — retry in ${retryAfterSeconds}s`);
  }
}

interface ApiLeague {
  slug: string;
  name: string;
  eventsCount: number;
}

interface ApiOddsEntry {
  hdp?: number;
  over?: string;
  under?: string;
  home?: string;
  draw?: string;
  away?: string;
  yes?: string;
  no?: string;
  [key: string]: unknown;
}

interface ApiMarket {
  name: string;
  odds: ApiOddsEntry[];
}

interface ApiEvent {
  id: number;
  home: string;
  away: string;
  date: string;
  status: string;
  bookmakers?: Record<string, ApiMarket[]>;
}

function parseRetryAfter(body: string): number {
  const match = body.match(/resets in (\d+) minutes? and (\d+) seconds?/);
  if (match) return parseInt(match[1]!) * 60 + parseInt(match[2]!);
  return 3600;
}

async function apiGet<T>(url: string, label: string): Promise<T> {
  const res = await fetch(url);
  if (res.status === 429) {
    const body = await res.text().catch(() => "");
    throw new RateLimitError(parseRetryAfter(body));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`odds-api.io ${res.status} [${label}]: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchActiveLeagueSlugs(apiKey: string): Promise<Set<string>> {
  try {
    const data = await apiGet<ApiLeague[]>(
      `${BASE_URL}/leagues?apiKey=${apiKey}&sport=football&all=true`,
      "leagues",
    );
    return new Set(data.filter((l) => l.eventsCount > 0).map((l) => l.slug));
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    logger.error({ err }, "Failed to fetch active leagues");
    return new Set();
  }
}

async function fetchLeagueEvents(leagueSlug: string, apiKey: string): Promise<ApiEvent[]> {
  const params = new URLSearchParams({
    apiKey,
    sport: "football",
    league: leagueSlug,
    status: "pending",
  });
  const data = await apiGet<ApiEvent | ApiEvent[]>(
    `${BASE_URL}/events?${params}`,
    `events:${leagueSlug}`,
  );
  return Array.isArray(data) ? data : [data];
}

async function fetchEventOdds(eventId: number, apiKey: string, bookmakers: string): Promise<ApiEvent> {
  const params = new URLSearchParams({ apiKey, eventId: String(eventId), bookmakers });
  return apiGet<ApiEvent>(`${BASE_URL}/odds?${params}`, `odds:${eventId}`);
}

async function saveEventAndOdds(event: ApiEvent, leagueSlug: string, leagueIdMap: Map<string, number>) {
  const leagueId = leagueIdMap.get(leagueSlug);
  if (!leagueId) {
    logger.warn({ leagueSlug }, "No league_id found for league — skipping fixture upsert");
  } else {
    // 1. Upsert fixture to Supabase
    const { error: fixtureErr } = await supabase
      .from("fixtures")
      .upsert(
        {
          fixture_id: event.id,
          league_id: leagueId,
          league_name: leagueSlug,
          home_team_name: event.home,
          away_team_name: event.away,
          fixture_date: event.date,
          status_short: event.status,
          status_long: event.status,
        },
        { onConflict: "fixture_id" },
      );
    if (fixtureErr) {
      logger.warn({ error: fixtureErr, eventId: event.id }, "Supabase fixture upsert warning");
    }
  }

  if (!event.bookmakers) return;

  // 2. Upsert odds to Supabase
  for (const [bookmaker, markets] of Object.entries(event.bookmakers)) {
    const firstMarket = markets[0];
    if (firstMarket && firstMarket.odds.length >= 2) {
      const odds = firstMarket.odds[0];
      const { error: oddsErr } = await supabase
        .from("odds_history")
        .upsert(
          {
            match_id: String(event.id),
            home_team: event.home,
            away_team: event.away,
            commence_time: event.date,
            bookmaker,
            market_type: firstMarket.name,
            odds_1: odds.home ? parseFloat(odds.home) : null,
            odds_2: odds.away ? parseFloat(odds.away) : null,
            odds_draw: odds.draw ? parseFloat(odds.draw) : null,
            captured_at: new Date().toISOString(),
          },
          { onConflict: "match_id, bookmaker" },
        );
      if (oddsErr) {
        logger.warn({ error: oddsErr, eventId: event.id, bookmaker }, "Supabase odds upsert warning");
      }
    }
  }
}

async function getAlreadySyncedEventIds(eventIds: number[]): Promise<Set<number>> {
  if (eventIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("fixtures")
    .select("fixture_id")
    .in("fixture_id", eventIds);
  if (error) {
    logger.error({ error }, "Failed to fetch already synced fixtures");
    return new Set();
  }
  return new Set((data ?? []).map((r) => r.fixture_id));
}

export async function fetchAndSaveLeagueOdds(
  league: LeagueConfig,
  apiKey: string,
  bookmakers: string,
  leagueIdMap: Map<string, number>,
): Promise<{ league: string; saved: number; skipped: boolean; errors: number }> {
  let saved = 0;
  let errors = 0;

  try {
    logger.info({ league: league.slug }, "Fetching events for league");
    const events = await fetchLeagueEvents(league.slug, apiKey);

    if (events.length === 0) {
      logger.info({ league: league.slug }, "No pending events — skipping");
      return { league: league.slug, saved: 0, skipped: true, errors: 0 };
    }

    const allIds = events.map((e) => e.id);
    const alreadySynced = await getAlreadySyncedEventIds(allIds);
    const toFetch = events.filter((e) => !alreadySynced.has(e.id));

    logger.info(
      { league: league.slug, total: events.length, alreadySynced: alreadySynced.size, toFetch: toFetch.length },
      "Events found",
    );

    for (const event of toFetch) {
      try {
        await new Promise((r) => setTimeout(r, 300));
        const withOdds = await fetchEventOdds(event.id, apiKey, bookmakers);
        await saveEventAndOdds(withOdds, league.slug, leagueIdMap);
        saved++;
      } catch (err) {
        if (err instanceof RateLimitError) {
          logger.warn({ retryAfter: err.retryAfterSeconds, saved }, "Rate limited — stopping sync early");
          return { league: league.slug, saved, skipped: false, errors };
        }
        errors++;
        logger.error({ err, eventId: event.id }, "Failed to fetch/save odds for event");
      }
    }
  } catch (err) {
    if (err instanceof RateLimitError) {
      logger.warn({ retryAfter: err.retryAfterSeconds }, "Rate limited on league events fetch");
      throw err;
    }
    logger.error({ err, league: league.slug }, "Failed to process league");
    errors++;
  }

  logger.info({ league: league.slug, saved, errors }, "League sync done");
  return { league: league.slug, saved, skipped: false, errors };
}

export async function fetchAndSaveAllLeagues(
  leagues: LeagueConfig[] = DEFAULT_LEAGUES,
  bookmakers = "Bet365,Sbobet",
): Promise<void> {
  if (syncRunning) {
    logger.warn("Sync already running — skipping");
    return;
  }
  const apiKey = process.env["ODDS_API_KEY"];
  if (!apiKey) {
    logger.error("ODDS_API_KEY is not set — skipping odds fetch");
    return;
  }

  syncRunning = true;
  logger.info({ leagueCount: leagues.length }, "Starting odds sync — checking active leagues");

  let activeSlugs: Set<string>;
  try {
    activeSlugs = await fetchActiveLeagueSlugs(apiKey);
  } catch (err) {
    syncRunning = false;
    if (err instanceof RateLimitError) {
      logger.warn({ retryAfter: err.retryAfterSeconds }, "Rate limited fetching leagues — will retry next cycle");
      return;
    }
    throw err;
  }

  logger.info({ activeCount: activeSlugs.size }, "Active leagues fetched from API");

  const leaguesToSync = leagues.filter((l) => activeSlugs.has(l.slug));
  const offSeason = leagues.filter((l) => !activeSlugs.has(l.slug)).map((l) => l.name);

  if (offSeason.length > 0) {
    logger.info({ offSeason }, "Leagues off-season — skipping");
  }

  if (leaguesToSync.length === 0) {
    syncRunning = false;
    logger.info("No active leagues to sync right now — will retry next cycle");
    return;
  }

  // Build league_id map from Supabase
  let leagueIdMap: Map<string, number>;
  try {
    const { data: leaguesData } = await supabase
      .from("leagues")
      .select("id, name, slug")
      .eq("is_active", true);
    leagueIdMap = new Map((leaguesData ?? []).map((l) => [l.slug ?? l.name, l.id]));
    logger.info({ leagueIdMapSize: leagueIdMap.size }, "League ID map loaded");
  } catch (err) {
    logger.warn({ err }, "Failed to load league ID map — using empty map");
    leagueIdMap = new Map();
  }

  try {
    for (const league of leaguesToSync) {
      await fetchAndSaveLeagueOdds(league, apiKey, bookmakers, leagueIdMap);
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (err) {
    if (err instanceof RateLimitError) {
      logger.warn("Rate limited mid-sync — stopping. Next cycle will continue from unsynced events.");
      syncRunning = false;
      return;
    }
    throw err;
  }

  syncRunning = false;
  logger.info("All leagues odds sync complete");
}
