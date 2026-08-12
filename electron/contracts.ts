export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface BrowserTabState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed?: boolean;
}

export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserEngineContext {
  sessionId: string;
  actionId: string;
  tabId: string;
  controlEpoch: number;
  fileRoots: string[];
}

export type BrowserOperation =
  | { operation: "open_tab"; url?: string | null }
  | { operation: "select_tab"; tabId: string }
  | { operation: "close_tab"; tabId: string }
  | { operation: "navigate"; tabId: string; url: string }
  | { operation: "go_back"; tabId: string }
  | { operation: "go_forward"; tabId: string }
  | { operation: "reload"; tabId: string }
  | { operation: "snapshot"; tabId: string; includeScreenshot?: boolean; sinceObservationId?: string | null }
  | { operation: "click"; tabId: string; reference: string }
  | { operation: "fill"; tabId: string; reference: string; value: string }
  | { operation: "press"; tabId: string; key: string }
  | { operation: "hover"; tabId: string; reference: string }
  | { operation: "scroll"; tabId: string; deltaX: number; deltaY: number }
  | { operation: "drag"; tabId: string; fromReference: string; toReference: string }
  | { operation: "wait"; tabId: string; condition: string; timeoutMs: number }
  | { operation: "evaluate"; tabId: string; expression: string }
  | { operation: "screenshot"; tabId: string; fullPage: boolean }
  | { operation: "console_list"; tabId: string }
  | { operation: "console_get"; tabId: string; entryId: string }
  | { operation: "network_list"; tabId: string }
  | { operation: "network_get"; tabId: string; requestId: string }
  | { operation: "trace_start"; tabId: string }
  | { operation: "trace_stop"; tabId: string }
  | { operation: "resize"; tabId: string; width: number; height: number }
  | { operation: "emulate"; tabId: string; device: string }
  | { operation: "storage"; tabId: string; command: string; value?: JsonValue }
  | { operation: "handle_dialog"; tabId: string; accept: boolean; promptText?: string | null }
  | { operation: "upload"; tabId: string; reference: string; paths: string[] }
  | { operation: "downloads"; tabId: string };

export interface BrowserArtifact {
  id: string;
  uri: string;
  mimeType: string;
  byteLength: number;
  title?: string;
  dataBase64?: string;
}

export interface BrowserOperationResult {
  tabId: string | null;
  controlEpoch: number;
  observationId?: string;
  value: JsonValue;
  artifacts: BrowserArtifact[];
}

export interface BrowserAnnotation {
  id: string;
  tabId: string;
  url: string;
  selector: string;
  tagName: string;
  role: string | null;
  name: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  createdAt: number;
}

export interface HostRequest {
  type: "host_request";
  id: number;
  method: string;
  params: JsonValue;
}

export interface HostResponse {
  type: "host_response";
  id: number;
  result?: JsonValue;
  error?: { code: string; message: string };
}

export interface SidecarRequest {
  type: "request";
  id: number;
  method: string;
  params: JsonValue;
}

export interface SidecarResponse {
  type: "response";
  id: number;
  result?: JsonValue;
  error?: { code: string; message: string };
}

export interface SidecarEvent {
  type: "event";
  event: string;
  payload: JsonValue;
}
