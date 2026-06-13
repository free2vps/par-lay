import { useState } from "react";
import { useListTeamStats, useListAvailableLeagues } from "@/api/parlay-hooks";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

function XgVsActualIndicator({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  if (value > 0.05) return (
    <span className="flex items-center gap-1 text-emerald-400 font-mono tabular-nums">
      <TrendingUp className="w-3 h-3" />+{value.toFixed(2)}
    </span>
  );
  if (value < -0.05) return (
    <span className="flex items-center gap-1 text-red-400 font-mono tabular-nums">
      <TrendingDown className="w-3 h-3" />{value.toFixed(2)}
    </span>
  );
  return (
    <span className="flex items-center gap-1 text-muted-foreground font-mono tabular-nums">
      <Minus className="w-3 h-3" />{value.toFixed(2)}
    </span>
  );
}

function fmt(v: number | null | undefined) {
  if (v == null) return <span className="text-muted-foreground">—</span>;
  return <span className="font-mono tabular-nums">{v.toFixed(2)}</span>;
}

export default function Teams() {
  const [leagueSlug, setLeagueSlug] = useState<string>("all");
  const [season, setSeason] = useState<string>("");
  const [search, setSearch] = useState<string>("");

  const { data: leagues } = useListAvailableLeagues();
  const { data: teams, isLoading } = useListTeamStats(
    leagueSlug === "all" && !season
      ? undefined
      : {
          leagueSlug: leagueSlug === "all" ? undefined : leagueSlug,
          season: season || undefined,
        }
  );

  const filtered = teams?.filter((t) =>
    (t.team_name ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Team Stats</h1>
          <p className="text-muted-foreground text-sm">xG / xGA data from FootyStats CSV uploads.</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <Input
            data-testid="input-team-search"
            placeholder="Search team..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-48"
          />
          <Select value={leagueSlug} onValueChange={setLeagueSlug}>
            <SelectTrigger className="w-full sm:w-52" data-testid="select-league">
              <SelectValue placeholder="All Leagues" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Leagues</SelectItem>
              {leagues?.map((l) => (
                <SelectItem key={l.slug} value={l.slug}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            data-testid="input-season"
            placeholder="Season (e.g. 2024-25)"
            value={season}
            onChange={(e) => setSeason(e.target.value)}
            className="w-full sm:w-44"
          />
        </div>
      </div>

      <Card className="bg-card border-border overflow-hidden">
        <Table>
          <TableHeader className="bg-secondary/50">
            <TableRow className="border-border">
              <TableHead>Team</TableHead>
              <TableHead>League</TableHead>
              <TableHead>Season</TableHead>
              <TableHead className="text-right">xG</TableHead>
              <TableHead className="text-right">xGA</TableHead>
              <TableHead className="text-right">xGD</TableHead>
              <TableHead className="text-right">GF</TableHead>
              <TableHead className="text-right">GA</TableHead>
              <TableHead className="text-right">xG vs Actual</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i} className="border-border">
                  {Array.from({ length: 9 }).map((__, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : filtered?.length ? (
              filtered.map((team) => (
                <TableRow key={team.id} className="border-border hover:bg-secondary/20 transition-colors" data-testid={`row-team-${team.id}`}>
                  <TableCell className="font-semibold">{team.team_name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-xs">{team.league_slug}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{team.season}</TableCell>
                  <TableCell className="text-right">{fmt(team.xg_per_match)}</TableCell>
                  <TableCell className="text-right">{fmt(team.xga_per_match)}</TableCell>
                  <TableCell className="text-right">{fmt(team.xgd_per_match)}</TableCell>
                  <TableCell className="text-right">{fmt(team.gf_per_match)}</TableCell>
                  <TableCell className="text-right">{fmt(team.ga_per_match)}</TableCell>
                  <TableCell className="text-right">
                    <XgVsActualIndicator value={team.xg_vs_actual} />
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                  {teams?.length === 0 ? "No team stats found. Upload a CSV to get started." : "No teams match your search."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {filtered && filtered.length > 0 && (
        <p className="text-xs text-muted-foreground text-right">{filtered.length} teams</p>
      )}
    </div>
  );
}
