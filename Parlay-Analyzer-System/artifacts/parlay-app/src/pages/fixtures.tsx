import { useState, Fragment } from "react";
import { useListEvents, useGetEvent, useListAvailableLeagues } from "@/api/parlay-hooks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";

interface OddsEntry {
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

interface Market {
  name: string;
  odds: OddsEntry[];
}

function MarketTable({ markets }: { markets: Market[] }) {
  return (
    <div className="space-y-3">
      {markets.map((market) => (
        <div key={market.name}>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
            {market.name}
          </div>
          <div className="space-y-1">
            {market.odds.map((o, i) => (
              <div key={i} className="flex justify-between text-xs font-mono">
                <span className="text-muted-foreground">
                  {o.home !== undefined && o.away !== undefined ? `${o.home} vs ${o.away}` :
                   o.over !== undefined && o.under !== undefined ? `${o.over} / ${o.under}` :
                   o.yes !== undefined && o.no !== undefined ? `${o.yes} / ${o.no}` :
                   o.draw !== undefined ? `${o.home} / ${o.draw} / ${o.away}` :
                   JSON.stringify(o)}
                </span>
                <span className="text-primary">
                  {o.hdp !== undefined ? `HDP ${o.hdp}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EventExpandedRow({ eventId }: { eventId: number }) {
  const { data: eventDetail, isLoading } = useGetEvent(eventId);

  if (isLoading) return (
    <TableRow>
      <TableCell colSpan={6} className="bg-secondary/30 p-4">
        <Skeleton className="h-20 w-full" />
      </TableCell>
    </TableRow>
  );

  if (!eventDetail || !eventDetail.bookmakers) return null;

  const bookmakers = Object.entries(eventDetail.bookmakers) as [string, Market[]][];

  return (
    <TableRow className="bg-secondary/20 hover:bg-secondary/20 border-b border-border">
      <TableCell colSpan={6} className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {bookmakers.length > 0 ? bookmakers.map(([name, markets]) => (
            <Card key={name} className="bg-background border-border shadow-none">
              <CardHeader className="p-3 pb-2 border-b border-border/50">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider">{name}</CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <MarketTable markets={markets} />
              </CardContent>
            </Card>
          )) : (
            <div className="text-sm text-muted-foreground col-span-full">No odds data available.</div>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function Fixtures() {
  const [leagueSlug, setLeagueSlug] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: leagues, isLoading: isLeaguesLoading } = useListAvailableLeagues();
  const { data: events, isLoading: isEventsLoading } = useListEvents(
    leagueSlug === "all" ? undefined : { league: leagueSlug, limit: 100 }
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Fixtures & Odds</h1>
          <p className="text-muted-foreground text-sm">Upcoming events and live bookmaker odds.</p>
        </div>
        
        <div className="w-full sm:w-64">
          <Select value={leagueSlug} onValueChange={setLeagueSlug}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by League" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Leagues</SelectItem>
              {leagues?.map((l) => (
                <SelectItem key={l.slug} value={l.slug}>{l.name} ({l.eventsCount})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="bg-card border-border overflow-hidden">
        <Table>
          <TableHeader className="bg-secondary/50">
            <TableRow className="border-border">
              <TableHead className="w-[120px]">Date</TableHead>
              <TableHead>League</TableHead>
              <TableHead>Home</TableHead>
              <TableHead>Away</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isEventsLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i} className="border-border">
                  <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : events?.length ? (
              events.map((event) => (
                <Fragment key={event.id}>
                  <TableRow 
                    className="border-border cursor-pointer hover:bg-secondary/30 transition-colors"
                    onClick={() => setExpandedId(expandedId === event.id ? null : event.id)}
                  >
                    <TableCell className="font-medium whitespace-nowrap">
                      {format(new Date(event.date), "MMM dd, HH:mm")}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">{event.leagueSlug}</Badge>
                    </TableCell>
                    <TableCell className="font-bold">{event.home}</TableCell>
                    <TableCell className="font-bold">{event.away}</TableCell>
                    <TableCell>
                      <Badge className={event.status === 'active' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}>
                        {event.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs font-medium text-primary">
                      {expandedId === event.id ? 'CLOSE' : 'ODDS'}
                    </TableCell>
                  </TableRow>
                  {expandedId === event.id && <EventExpandedRow eventId={event.id} />}
                </Fragment>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No fixtures found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
