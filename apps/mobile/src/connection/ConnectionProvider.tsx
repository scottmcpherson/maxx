import * as Device from "expo-device";
import { AppState } from "react-native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RuntimeEventEnvelope, TurnFinishedEnvelope, WorkspaceDocument } from "../types";
import { MaxxHostClient } from "./MaxxHostClient";
import type { MaxxMobilePairingPayload } from "./pairingPayload";
import { MOBILE_REQUIRED_CAPABILITIES, parseEndpoint } from "./pairingPayload";
import {
  automaticReconnectDelay,
  shouldAutomaticallyReconnect,
  shouldShowReconnectProgress,
  type ReconnectReason,
} from "./reconnectPolicy";
import {
  clearSavedConnection,
  deviceID,
  loadSavedConnection,
  saveConnection,
  type SavedHostProfile,
} from "./secureStore";
import { applyRuntimeEvent, mergeLiveRuntimeEvents } from "./workspaceRuntimeEvents";

export type ConnectionState =
  | { status: "loading" }
  | { status: "unpaired" }
  | { status: "connecting"; profile?: SavedHostProfile }
  | { status: "connected"; profile: SavedHostProfile }
  | { status: "disconnected"; profile: SavedHostProfile; error: string; automaticRetry: boolean };

type ConnectionContextValue = {
  state: ConnectionState;
  workspace: WorkspaceDocument | null;
  client: MaxxHostClient | null;
  pair: (payload: MaxxMobilePairingPayload) => Promise<void>;
  pairManually: (address: string, code: string) => Promise<void>;
  reconnect: () => Promise<void>;
  forget: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
};

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnectionState>({ status: "loading" });
  const [workspace, setWorkspace] = useState<WorkspaceDocument | null>(null);
  const [client, setClient] = useState<MaxxHostClient | null>(null);
  const clientRef = useRef<MaxxHostClient | null>(null);
  const reconnectingRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedLiveTurnsRef = useRef(new Set<string>());

  const installClient = useCallback(async (nextClient: MaxxHostClient, profile: SavedHostProfile) => {
    clientRef.current?.close();
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
    clientRef.current = nextClient;
    setClient(nextClient);
    setState({ status: "connected", profile });
    initializedLiveTurnsRef.current.clear();
    const refresh = async (preserveLiveEvents = false) => {
      try {
        const next = await nextClient.request<WorkspaceDocument>("workspace_snapshot");
        if (clientRef.current === nextClient) {
          setWorkspace((current) => preserveLiveEvents ? mergeLiveRuntimeEvents(next, current) : next);
        }
      } catch (error) {
        if (clientRef.current === nextClient) {
          setState({
            status: "disconnected",
            profile,
            error: errorMessage(error),
            automaticRetry: shouldAutomaticallyReconnect(error),
          });
        }
      }
    };
    const scheduleRefresh = (delay: number, preserveLiveEvents: boolean, replacePending = false) => {
      if (refreshTimerRef.current) {
        if (!replacePending) return;
        clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void refresh(preserveLiveEvents);
      }, delay);
    };
    nextClient.onEvent((event) => {
      if (event.event === "voice://event") return;
      if (event.event === "runtime://event") {
        const envelope = event.payload as RuntimeEventEnvelope;
        if (!envelope?.projectID || !envelope.threadID || !envelope.event?.id) return;
        setWorkspace((current) => applyRuntimeEvent(current, envelope));
        const turnKey = `${envelope.projectID}:${envelope.threadID}:${envelope.event.turnID}`;
        const isNewTurn = !initializedLiveTurnsRef.current.has(turnKey);
        if (isNewTurn) initializedLiveTurnsRef.current.add(turnKey);
        const needsInteractionSnapshot = envelope.event.kind === "request.approval"
          || envelope.event.kind === "request.user-input";
        if (isNewTurn || needsInteractionSnapshot) scheduleRefresh(80, true);
        return;
      }
      if (event.event === "turn://finished") {
        const envelope = event.payload as TurnFinishedEnvelope;
        if (envelope?.projectID && envelope.threadID && envelope.turnID) {
          initializedLiveTurnsRef.current.delete(`${envelope.projectID}:${envelope.threadID}:${envelope.turnID}`);
        }
        scheduleRefresh(0, false, true);
        return;
      }
      scheduleRefresh(120, true, true);
    });
    nextClient.onClose((error) => {
      if (clientRef.current !== nextClient) return;
      clientRef.current = null;
      setClient(null);
      const reason = error || new Error("Connection lost.");
      setState({
        status: "disconnected",
        profile,
        error: errorMessage(reason),
        automaticRetry: shouldAutomaticallyReconnect(reason),
      });
    });
    await refresh();
  }, []);

  const connectSaved = useCallback(async (
    profile: SavedHostProfile,
    credential: string,
    reason: ReconnectReason,
  ) => {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    if (shouldShowReconnectProgress(reason)) {
      setState({ status: "connecting", profile });
    }
    try {
      const identity = await deviceID();
      const result = await MaxxHostClient.reconnect({
        address: profile.address,
        credential,
        clientId: identity,
        clientName: Device.deviceName || "iPhone",
      });
      if (result.hostId !== profile.hostId) {
        result.client.close();
        throw new Error("The saved address now belongs to a different Maxx host.");
      }
      if (!MOBILE_REQUIRED_CAPABILITIES.every((capability) => result.capabilities.includes(capability))) {
        result.client.close();
        throw new Error("This device no longer has Maxx Mobile access. Pair it again from your Mac.");
      }
      await installClient(result.client, { ...profile, hostName: result.hostName });
    } catch (error) {
      setClient(null);
      setState({
        status: "disconnected",
        profile,
        error: errorMessage(error),
        automaticRetry: shouldAutomaticallyReconnect(error),
      });
    } finally {
      reconnectingRef.current = false;
    }
  }, [installClient]);

  useEffect(() => {
    let cancelled = false;
    void loadSavedConnection().then((saved) => {
      if (cancelled) return;
      if (!saved) {
        setState({ status: "unpaired" });
        return;
      }
      void connectSaved(saved.profile, saved.credential, "startup");
    });
    return () => {
      cancelled = true;
      clientRef.current?.close();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [connectSaved]);

  useEffect(() => {
    if (state.status === "connected" || state.status === "unpaired") {
      reconnectAttemptRef.current = 0;
    }
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    if (state.status !== "disconnected" || !state.automaticRetry || AppState.currentState !== "active") return;

    const delay = automaticReconnectDelay(reconnectAttemptRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectAttemptRef.current += 1;
      if (AppState.currentState !== "active") return;
      void loadSavedConnection().then((saved) => {
        if (saved) void connectSaved(saved.profile, saved.credential, "automatic");
      });
    }, delay);

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    };
  }, [connectSaved, state]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") {
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
        return;
      }
      if (state.status !== "disconnected" || !state.automaticRetry) return;
      reconnectAttemptRef.current = 0;
      void loadSavedConnection().then((saved) => {
        if (saved) void connectSaved(saved.profile, saved.credential, "automatic");
      });
    });
    return () => subscription.remove();
  }, [connectSaved, state]);

  const pairAt = useCallback(async (
    address: string,
    code: string,
    expectedHostId?: string,
    advertisedName?: string,
  ) => {
    const endpoint = parseEndpoint(address);
    setState({ status: "connecting" });
    try {
      const identity = await deviceID();
      const result = await MaxxHostClient.pair({
        address: endpoint.address,
        code,
        clientId: identity,
        clientName: Device.deviceName || "iPhone",
      });
      if (expectedHostId && result.hostId !== expectedHostId) {
        result.client.close();
        throw new Error("The Maxx host identity did not match the pairing QR code.");
      }
      if (!MOBILE_REQUIRED_CAPABILITIES.every((capability) => result.capabilities.includes(capability))) {
        result.client.close();
        throw new Error("This pairing code does not grant Maxx Mobile access. Generate a Mobile code on your Mac.");
      }
      if (!result.credential) throw new Error("The device credential was not created.");
      const profile: SavedHostProfile = {
        hostId: result.hostId,
        hostName: result.hostName || advertisedName || "Maxx",
        address: endpoint.address,
        capabilities: result.capabilities,
        pairedAt: Math.floor(Date.now() / 1000),
      };
      await saveConnection(profile, result.credential);
      await installClient(result.client, profile);
    } catch (error) {
      setWorkspace(null);
      setState({ status: "unpaired" });
      throw error;
    }
  }, [installClient]);

  const pair = useCallback((payload: MaxxMobilePairingPayload) => pairAt(
    payload.host.address,
    payload.pairing.code,
    payload.host.id,
    payload.host.name,
  ), [pairAt]);

  const pairManually = useCallback((address: string, code: string) => pairAt(address, code), [pairAt]);

  const reconnect = useCallback(async () => {
    reconnectAttemptRef.current = 0;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    const saved = await loadSavedConnection();
    if (!saved) {
      setState({ status: "unpaired" });
      return;
    }
    await connectSaved(saved.profile, saved.credential, "manual");
  }, [connectSaved]);

  const forget = useCallback(async () => {
    reconnectAttemptRef.current = 0;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    const current = clientRef.current;
    if (current) {
      try {
        await current.request("host_forget_peer");
      } catch {
        // Local credentials are still removed if the host is unavailable.
      }
      current.close();
    }
    clientRef.current = null;
    setClient(null);
    setWorkspace(null);
    await clearSavedConnection();
    setState({ status: "unpaired" });
  }, []);

  const refreshWorkspace = useCallback(async () => {
    const current = clientRef.current;
    if (!current) throw new Error("Maxx is disconnected.");
    const next = await current.request<WorkspaceDocument>("workspace_snapshot");
    setWorkspace((workspace) => mergeLiveRuntimeEvents(next, workspace));
  }, []);

  const value = useMemo<ConnectionContextValue>(() => ({
    state,
    workspace,
    client,
    pair,
    pairManually,
    reconnect,
    forget,
    refreshWorkspace,
  }), [client, forget, pair, pairManually, reconnect, refreshWorkspace, state, workspace]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection() {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error("useConnection must be used inside ConnectionProvider.");
  return value;
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error);
}
