import { useCallback, useEffect, useId, useState } from "react";
import type {
  ProviderHealth,
  ProviderModelOption,
  ProviderProfile,
} from "../contract/types";
import { ipc } from "../ipc";
import {
  PROVIDER_INSTALL_GUIDES,
  filterProviderModels,
  setModelVisibility,
} from "../providerSettings";
import { Icons } from "./Icons";
import { ProviderIcon } from "./ProviderIcon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface ProviderSettingsRowProps {
  profile: ProviderProfile;
  health?: ProviderHealth;
  subtitle: string;
  expanded: boolean;
  pending: boolean;
  workingDirectory?: string;
  onToggleExpanded: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onSaveProfile: (profile: ProviderProfile) => Promise<void>;
  onRecheck: () => Promise<void>;
}

export function ProviderSettingsRow({
  profile,
  health,
  subtitle,
  expanded,
  pending,
  workingDirectory,
  onToggleExpanded,
  onToggleEnabled,
  onSaveProfile,
  onRecheck,
}: ProviderSettingsRowProps) {
  const guide = PROVIDER_INSTALL_GUIDES[profile.provider];
  const [executablePath, setExecutablePath] = useState(profile.executablePath ?? "");
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const detailsId = useId();

  useEffect(() => {
    setExecutablePath(profile.executablePath ?? "");
  }, [profile.executablePath]);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const catalog = await ipc.listProviderModels(
        profile.provider,
        profile.id,
        workingDirectory,
      );
      if (catalog.source === "live") {
        setModels(catalog.models);
      } else {
        setModels([]);
        setModelsError(catalog.error ?? "Model discovery failed.");
      }
    } catch (error) {
      setModels([]);
      setModelsError(String(error));
    } finally {
      setModelsLoading(false);
    }
  }, [profile.provider, profile.id, workingDirectory]);

  useEffect(() => {
    if (expanded) void loadModels();
  }, [expanded, loadModels]);

  const normalizedPath = executablePath.trim();
  const savedPath = profile.executablePath ?? "";
  const pathChanged = normalizedPath !== savedPath;
  const status = pending ? "checking" : health?.state ?? "checking";
  const filteredModels = filterProviderModels(models, modelQuery);
  const hasModelQuery = modelQuery.trim().length > 0;

  const savePath = async () => {
    await onSaveProfile({
      ...profile,
      executablePath: normalizedPath || undefined,
    });
    await Promise.all([onRecheck(), loadModels()]);
  };

  return (
    <div className={cn("flex flex-col text-card-foreground", expanded && "bg-muted/10")}>
      <div
        className="pointer-events-none relative flex min-h-11 flex-wrap items-center gap-3 px-3 py-2"
      >
        <Button
          type="button"
          variant="ghost"
          className="pointer-events-auto absolute inset-0 z-0 h-full w-full rounded-none p-0 hover:bg-muted/30 focus-visible:bg-muted/30"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${profile.displayName} details`}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={onToggleExpanded}
        />
        <span className="relative z-10 flex size-6 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
          {expanded ? <Icons.chevronDown /> : <Icons.chevronRight />}
        </span>
        <span className="relative z-10 flex shrink-0" aria-hidden="true">
          <ProviderIcon provider={profile.provider} size={20} />
        </span>
        <div className="relative z-10 flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="truncate text-sm">{profile.displayName}</strong>
          <span className="truncate text-xs text-muted-foreground">{pending ? "Checking installation…" : subtitle}</span>
        </div>
        <Badge
          variant={status === "missing" ? "destructive" : "secondary"}
          className={cn("relative z-10", status === "ready" && "bg-success/10 text-success")}
        >
          {status}
        </Badge>
        <div
          className="pointer-events-auto relative z-10 flex shrink-0 items-center"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Switch
            checked={profile.isEnabled}
            disabled={pending}
            aria-label={`Enable ${profile.displayName}`}
            onCheckedChange={onToggleEnabled}
          />
        </div>
      </div>

      {expanded && (
        <div id={detailsId} className="flex flex-col gap-5 border-t border-border/50 p-4">
          {health?.state === "missing" && (
            <Alert>
              <AlertTitle>{profile.displayName} is not available.</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>Install the CLI or point Maxx at an existing executable, then recheck.</span>
                <Button
                  size="sm"
                  render={<a
                    href={guide.url}
                    target="_blank"
                    rel="noreferrer"
                  />}
                  nativeButton={false}
                >
                  Install {profile.displayName}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <section className="flex flex-col gap-3">
            <div className="grid grid-cols-1 items-start gap-2 @2xl:grid-cols-[minmax(0,1fr)_auto] @2xl:gap-3">
              <div className="flex flex-col gap-1">
                <strong className="text-sm">Executable</strong>
                <FieldDescription>
                  {health?.executablePath
                    ? `Detected at ${health.executablePath}`
                    : `Auto-detects ${guide.executable} in common install locations and PATH.`}
                </FieldDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => void Promise.all([onRecheck(), loadModels()])}
              >
                Recheck
              </Button>
            </div>
            <Field>
              <FieldLabel htmlFor={`${profile.id}-executable`} className="sr-only">Executable path</FieldLabel>
              <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  id={`${profile.id}-executable`}
                  value={executablePath}
                  aria-label={`${profile.displayName} executable path`}
                  placeholder={`Auto-detect ${guide.executable}`}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => setExecutablePath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && pathChanged) void savePath();
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!pathChanged || pending}
                  onClick={() => void savePath()}
                >
                  Save path
                </Button>
              </div>
            </Field>
            {health?.message && <p className="text-sm text-muted-foreground">{health.message}</p>}
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <strong className="text-sm">Models</strong>
                <FieldDescription>Turn off models you do not want shown in the composer model picker.</FieldDescription>
              </div>
              {!modelsLoading && models.length > 0 && (
                <span className="text-xs text-muted-foreground">{hasModelQuery ? `${filteredModels.length} of ${models.length}` : `${models.length} available`}</span>
              )}
            </div>
            {modelsLoading && <p className="text-sm text-muted-foreground" role="status">Loading models…</p>}
            {!modelsLoading && modelsError && (
              <Alert variant="destructive">
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>{modelsError}</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => void loadModels()}>Retry</Button>
                </AlertDescription>
              </Alert>
            )}
            {!modelsLoading && !modelsError && models.length === 0 && (
              <p className="text-sm text-muted-foreground">No models were reported by this provider.</p>
            )}
            {!modelsLoading && models.length > 0 && (
              <Field>
                <FieldLabel htmlFor={`${profile.id}-model-search`} className="sr-only">Search models</FieldLabel>
                <div className="relative">
                  <Icons.search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    id={`${profile.id}-model-search`}
                    className="pl-8"
                    type="search"
                    value={modelQuery}
                    aria-label={`Search ${profile.displayName} models`}
                    placeholder={`Search ${profile.displayName} models`}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(event) => setModelQuery(event.target.value)}
                  />
                </div>
              </Field>
            )}
            {!modelsLoading && models.length > 0 && filteredModels.length === 0 && (
              <p className="text-sm text-muted-foreground">No models match “{modelQuery.trim()}”.</p>
            )}
            {!modelsLoading && filteredModels.length > 0 && (
              <div
                className="flex max-h-60 flex-col divide-y overflow-y-auto overscroll-contain rounded-lg border"
                role="group"
                aria-label={`${profile.displayName} model visibility`}
              >
                {filteredModels.map((model) => {
                  const visible = !(profile.hiddenModels ?? []).includes(model.model);
                  return (
                    <div className="flex items-center gap-3 p-3" key={model.model}>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <strong className="truncate text-sm">{model.displayName}</strong>
                        {model.description && <span className="text-xs text-muted-foreground">{model.description}</span>}
                      </div>
                      <Switch
                        checked={visible}
                        aria-label={`Show ${model.displayName} in model picker`}
                        onCheckedChange={(checked) => void onSaveProfile(setModelVisibility(profile, model.model, checked))}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
