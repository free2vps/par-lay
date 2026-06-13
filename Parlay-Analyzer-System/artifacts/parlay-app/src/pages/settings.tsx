import { useState, useEffect } from "react";
import {
  useGetConfig,
  useSaveConfig,
  useTriggerSync,
  useGetSyncStatus,
  getGetConfigQueryKey,
  getGetSyncStatusQueryKey,
} from "@/api/parlay-hooks";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Save, Plus, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function TagList({
  label,
  items,
  onChange,
  placeholder,
  testId,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  testId: string;
}) {
  const [newItem, setNewItem] = useState("");

  function add() {
    const val = newItem.trim();
    if (val && !items.includes(val)) {
      onChange([...items, val]);
      setNewItem("");
    }
  }

  function remove(item: string) {
    onChange(items.filter((i) => i !== item));
  }

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2 min-h-8">
        {items.map((item) => (
          <Badge key={item} variant="secondary" className="flex items-center gap-1 font-mono text-xs" data-testid={`badge-${testId}-${item}`}>
            {item}
            <button
              type="button"
              onClick={() => remove(item)}
              className="ml-1 hover:text-destructive"
              data-testid={`button-remove-${testId}-${item}`}
            >
              <X className="w-3 h-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); }}}
          className="text-sm font-mono h-8"
          data-testid={`input-add-${testId}`}
        />
        <Button type="button" variant="outline" size="sm" onClick={add} data-testid={`button-add-${testId}`}>
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: config, isLoading } = useGetConfig();
  const { data: syncStatus } = useGetSyncStatus();
  const saveConfig = useSaveConfig();
  const triggerSync = useTriggerSync();

  const [leagues, setLeagues] = useState<string[]>([]);
  const [bookmakers, setBookmakers] = useState<string[]>([]);
  const [markets, setMarkets] = useState<string[]>([]);
  const [cronExpression, setCronExpression] = useState("0 */3 * * *");

  useEffect(() => {
    if (config) {
      setLeagues(config.leagues ?? []);
      setBookmakers(config.bookmakers ?? []);
      setMarkets(config.markets ?? []);
      setCronExpression(config.cronExpression ?? "0 */3 * * *");
    }
  }, [config]);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    saveConfig.mutate(
      { data: { leagues, bookmakers, markets, cronExpression } },
      {
        onSuccess: () => {
          toast({ title: "Config saved", description: "Scheduler configuration updated." });
          queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() });
        },
        onError: () => {
          toast({ title: "Save failed", variant: "destructive" });
        },
      }
    );
  }

  function handleTriggerSync() {
    triggerSync.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Sync started", description: "Manual odds sync triggered." });
        queryClient.invalidateQueries({ queryKey: getGetSyncStatusQueryKey() });
      },
      onError: () => {
        toast({ title: "Sync failed", variant: "destructive" });
      },
    });
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Settings</h1>
          <p className="text-muted-foreground text-sm">Scheduler configuration and manual controls.</p>
        </div>
        <Button
          variant="outline"
          onClick={handleTriggerSync}
          disabled={triggerSync.isPending || syncStatus?.isRunning}
          data-testid="button-trigger-sync"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${triggerSync.isPending || syncStatus?.isRunning ? "animate-spin" : ""}`} />
          {syncStatus?.isRunning ? "Syncing..." : "Trigger Sync"}
        </Button>
      </div>

      {syncStatus && (
        <Card className="bg-card border-border">
          <CardContent className="pt-4 flex flex-wrap gap-6 text-sm">
            <div>
              <span className="text-muted-foreground">Status </span>
              <span className={`font-medium ${syncStatus.isRunning ? "text-amber-400" : "text-emerald-400"}`}>
                {syncStatus.isRunning ? "Running" : "Idle"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Total events </span>
              <span className="font-mono font-bold">{syncStatus.totalEvents}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Last sync </span>
              <span className="font-mono text-xs">
                {syncStatus.lastSyncAt ? new Date(syncStatus.lastSyncAt).toLocaleString() : "Never"}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Scheduler Config</CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Controls which leagues, bookmakers, and markets are fetched on each cron run.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-6">
              <TagList
                label="Leagues"
                items={leagues}
                onChange={setLeagues}
                placeholder="soccer_epl"
                testId="leagues"
              />
              <TagList
                label="Bookmakers"
                items={bookmakers}
                onChange={setBookmakers}
                placeholder="bet365"
                testId="bookmakers"
              />
              <TagList
                label="Markets"
                items={markets}
                onChange={setMarkets}
                placeholder="h2h"
                testId="markets"
              />
              <div className="space-y-1.5">
                <Label htmlFor="cron">Cron Expression</Label>
                <Input
                  id="cron"
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                  placeholder="0 */3 * * *"
                  className="font-mono"
                  data-testid="input-cron"
                />
                <p className="text-xs text-muted-foreground">
                  Default: <code className="text-primary">0 */3 * * *</code> — every 3 hours
                </p>
              </div>
              <Button type="submit" disabled={saveConfig.isPending} data-testid="button-save-config">
                <Save className="w-4 h-4 mr-2" />
                {saveConfig.isPending ? "Saving..." : "Save Config"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
