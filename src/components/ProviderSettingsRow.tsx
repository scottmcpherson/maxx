import { useCallback, useEffect, useState } from "react";
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
    <div className={`provider-settings-row ${expanded ? "is-expanded" : ""}`}>
      <div className="provider-settings-summary">
        <ProviderIcon provider={profile.provider} size={20} />
        <span className="provider-settings-name">
          <strong>{profile.displayName}</strong>
          <small>{pending ? "Checking installation…" : subtitle}</small>
        </span>
        <span className={`health-badge health-${status}`}>{status}</span>
        <button
          type="button"
          className="provider-disclosure"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${profile.displayName} details`}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          {expanded ? <Icons.chevronDown size={14} /> : <Icons.chevronRight size={14} />}
        </button>
        <label className="switch">
          <input
            type="checkbox"
            checked={profile.isEnabled}
            disabled={pending}
            aria-label={`Enable ${profile.displayName}`}
            onChange={(event) => onToggleEnabled(event.target.checked)}
          />
          <span />
        </label>
      </div>

      {expanded && (
        <div className="provider-settings-details">
          {health?.state === "missing" && (
            <div className="provider-install-callout" role="status">
              <span>
                <strong>{profile.displayName} is not available.</strong>
                <small>Install the CLI or point Maxx at an existing executable, then recheck.</small>
              </span>
              <a
                className="provider-install-button"
                href={guide.url}
                target="_blank"
                rel="noreferrer"
              >
                Install {profile.displayName}
              </a>
            </div>
          )}

          <div className="provider-detail-section">
            <div className="provider-detail-heading">
              <span>
                <strong>Executable</strong>
                <small>
                  {health?.executablePath
                    ? `Detected at ${health.executablePath}`
                    : `Auto-detects ${guide.executable} in common install locations and PATH.`}
                </small>
              </span>
              <button
                type="button"
                className="settings-secondary-button"
                disabled={pending}
                onClick={() => void Promise.all([onRecheck(), loadModels()])}
              >
                Recheck
              </button>
            </div>
            <div className="provider-path-editor">
              <input
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
              <button
                type="button"
                className="settings-secondary-button"
                disabled={!pathChanged || pending}
                onClick={() => void savePath()}
              >
                Save path
              </button>
            </div>
            {health?.message && <p className="provider-health-message">{health.message}</p>}
          </div>

          <div className="provider-detail-section provider-model-settings">
            <div className="provider-detail-heading">
              <span>
                <strong>Models</strong>
                <small>Turn off models you do not want shown in the composer model picker.</small>
              </span>
              {!modelsLoading && models.length > 0 && (
                <small>{hasModelQuery ? `${filteredModels.length} of ${models.length}` : `${models.length} available`}</small>
              )}
            </div>
            {modelsLoading && <p className="provider-model-state">Loading models…</p>}
            {!modelsLoading && modelsError && (
              <div className="provider-model-state error" role="status">
                <span>{modelsError}</span>
                <button type="button" className="settings-secondary-button" onClick={() => void loadModels()}>
                  Retry
                </button>
              </div>
            )}
            {!modelsLoading && !modelsError && models.length === 0 && (
              <p className="provider-model-state">No models were reported by this provider.</p>
            )}
            {!modelsLoading && models.length > 0 && (
              <label className="provider-model-search">
                <Icons.search size={13} />
                <input
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
              </label>
            )}
            {!modelsLoading && models.length > 0 && filteredModels.length === 0 && (
              <p className="provider-model-state">No models match “{modelQuery.trim()}”.</p>
            )}
            {!modelsLoading && filteredModels.length > 0 && (
              <div className="provider-model-list" role="group" aria-label={`${profile.displayName} model visibility`}>
                {filteredModels.map((model) => {
                  const visible = !(profile.hiddenModels ?? []).includes(model.model);
                  return (
                    <div className="provider-model-row" key={model.model}>
                      <span>
                        <strong>{model.displayName}</strong>
                        {model.description && <small>{model.description}</small>}
                      </span>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={visible}
                          aria-label={`Show ${model.displayName} in model picker`}
                          onChange={(event) => void onSaveProfile(setModelVisibility(
                            profile,
                            model.model,
                            event.target.checked,
                          ))}
                        />
                        <span />
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
