import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const API_BASE = "/api";

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

/* ─── Sync Status ─── */
export const getGetSyncStatusQueryKey = () => ["sync/status"];
export function useGetSyncStatus() {
  return useQuery({
    queryKey: getGetSyncStatusQueryKey(),
    queryFn: () => apiGet(`${API_BASE}/sync/status`),
  });
}

/* ─── Available Leagues ─── */
export const getListAvailableLeaguesQueryKey = () => ["odds/available-leagues"];
export function useListAvailableLeagues() {
  return useQuery({
    queryKey: getListAvailableLeaguesQueryKey(),
    queryFn: () => apiGet(`${API_BASE}/odds/available-leagues`),
  });
}

/* ─── Supabase Parlays ─── */
export const getListSupabaseParlaysQueryKey = (params?: { status?: string }) => [
  "supabase/parlays",
  params,
];
export function useListSupabaseParlays(params?: { status?: string }) {
  return useQuery({
    queryKey: getListSupabaseParlaysQueryKey(params),
    queryFn: () => {
      const qs = params?.status ? `?status=${encodeURIComponent(params.status)}` : "";
      return apiGet(`${API_BASE}/supabase/parlays${qs}`);
    },
  });
}

/* ─── Supabase Fixtures ─── */
export const getListSupabaseFixturesQueryKey = (params?: Record<string, string | number>) => [
  "supabase/fixtures",
  params,
];
export function useListSupabaseFixtures(params?: Record<string, string | number>) {
  return useQuery({
    queryKey: getListSupabaseFixturesQueryKey(params),
    queryFn: () => {
      const qs = params ? new URLSearchParams(params as Record<string, string>).toString() : "";
      return apiGet(`${API_BASE}/supabase/fixtures${qs ? "?" + qs : ""}`);
    },
  });
}

/* ─── Events ─── */
export const getListEventsQueryKey = (params?: { league?: string; limit?: number }) => [
  "odds/events",
  params,
];
export function useListEvents(params?: { league?: string; limit?: number }) {
  return useQuery({
    queryKey: getListEventsQueryKey(params),
    queryFn: () => {
      const qs = params ? new URLSearchParams(params as Record<string, string>).toString() : "";
      return apiGet(`${API_BASE}/odds/events${qs ? "?" + qs : ""}`);
    },
  });
}

export const getGetEventQueryKey = (eventId: number) => ["odds/events", eventId];
export function useGetEvent(eventId: number) {
  return useQuery({
    queryKey: getGetEventQueryKey(eventId),
    queryFn: () => apiGet(`${API_BASE}/odds/events/${eventId}`),
    enabled: !!eventId,
  });
}

/* ─── Team Stats ─── */
export const getListTeamStatsQueryKey = (params?: { leagueSlug?: string; season?: string }) => [
  "csv/teams",
  params,
];
export function useListTeamStats(params?: { leagueSlug?: string; season?: string }) {
  return useQuery({
    queryKey: getListTeamStatsQueryKey(params),
    queryFn: () => {
      const qs = params ? new URLSearchParams(params as Record<string, string>).toString() : "";
      return apiGet(`${API_BASE}/csv/teams${qs ? "?" + qs : ""}`);
    },
  });
}

/* ─── Standings ─── */
export const getListStandingsQueryKey = (params?: { league_name?: string; season?: string }) => [
  "supabase/standings",
  params,
];
export function useListStandings(params?: { league_name?: string; season?: string }) {
  return useQuery({
    queryKey: getListStandingsQueryKey(params),
    queryFn: () => {
      const qs = params ? new URLSearchParams(params as Record<string, string>).toString() : "";
      return apiGet(`${API_BASE}/supabase/standings${qs ? "?" + qs : ""}`);
    },
  });
}

/* ─── Config ─── */
export const getGetConfigQueryKey = () => ["config"];
export function useGetConfig() {
  return useQuery({
    queryKey: getGetConfigQueryKey(),
    queryFn: () => apiGet(`${API_BASE}/config`),
  });
}

export function useSaveConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { data: Record<string, unknown> }) => apiPost(`${API_BASE}/config`, data.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() }),
  });
}

/* ─── Trigger Sync ─── */
export function useTriggerSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost(`${API_BASE}/sync/trigger`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetSyncStatusQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListEventsQueryKey() });
    },
  });
}
