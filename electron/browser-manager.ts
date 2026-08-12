import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  BrowserWindow,
  session,
  type Session,
  type WebContents,
  WebContentsView,
} from "electron";
import {
  ANNOTATION_DISABLE_SCRIPT,
  ANNOTATION_INSTALL_SCRIPT,
  dragScript,
  referenceScript,
  SNAPSHOT_SCRIPT,
} from "./browser-scripts.js";
import type {
  BrowserAnnotation,
  BrowserEngineContext,
  BrowserOperation,
  BrowserOperationResult,
  BrowserTabState,
  BrowserViewBounds,
  JsonValue,
} from "./contracts.js";
import type { ChromeImporter } from "./chrome-importer.js";

const MAX_DIAGNOSTICS = 300;
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
const MAX_CAPTURE_PIXELS = 16_000_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const HUMAN_INPUT_BINDING = "__maxxHumanInput";
const ANNOTATION_BINDING = "__maxxAnnotationPicked";

interface TabRecord {
  view: WebContentsView;
  contents: WebContents;
  state: BrowserTabState;
  generation: number;
  lastSnapshot?: { id: string; value: Record<string, JsonValue> };
  console: JsonValue[];
  network: JsonValue[];
  traceChunks: JsonValue[] | null;
  traceBytes: number;
  traceOverflow: boolean;
  agentInput: boolean;
  annotationEnabled: boolean;
  interruptGeneration: number;
  interruptWaiters: Set<() => void>;
}

interface BrowserManagerOptions {
  window: BrowserWindow;
  userDataPath: string;
  emitRenderer: (event: string, payload: JsonValue) => void;
  emitHostEvent: (event: string, payload: JsonValue) => void;
  chromeImporter: ChromeImporter;
}

function browserError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function validateURL(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw browserError("browser.invalid-url", `invalid browser URL: ${String(error)}`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw browserError("browser.invalid-url", "browser navigation accepts only absolute HTTP or HTTPS URLs");
  }
  return parsed.toString();
}

function redact(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = ["authorization", "proxy-authorization", "cookie", "set-cookie"].includes(key.toLowerCase())
        ? "[REDACTED]"
        : redact(child);
    }
    return output;
  }
  if (value === undefined) return null;
  return value as JsonValue;
}

function pushBounded(target: JsonValue[], value: JsonValue): void {
  target.push(value);
  if (target.length > MAX_DIAGNOSTICS) target.splice(0, target.length - MAX_DIAGNOSTICS);
}

function parseAnnotation(payload: string, tab: TabRecord): BrowserAnnotation | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    const rect = value.rect as Record<string, unknown> | undefined;
    if (
      typeof value.selector !== "string" || value.selector.length > 4_096 ||
      typeof value.tagName !== "string" || value.tagName.length > 64 ||
      (value.role !== null && typeof value.role !== "string") ||
      typeof value.name !== "string" || value.name.length > 1_000 ||
      typeof value.text !== "string" || value.text.length > 2_000 ||
      !rect || ![rect.x, rect.y, rect.width, rect.height].every((part) => typeof part === "number" && Number.isFinite(part))
    ) return null;
    return {
      id: randomUUID(),
      tabId: tab.state.id,
      url: tab.state.url,
      selector: value.selector,
      tagName: value.tagName,
      role: typeof value.role === "string" ? value.role.slice(0, 128) : null,
      name: value.name,
      text: value.text,
      rect: { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number },
      createdAt: Date.now(),
    };
  } catch {
    return null;
  }
}

function keyDefinition(key: string): { key: string; code: string; keyCode: number } {
  const normalized = key.toLowerCase();
  const known: Record<string, [string, string, number]> = {
    enter: ["Enter", "Enter", 13], return: ["Enter", "Enter", 13], tab: ["Tab", "Tab", 9],
    escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27], backspace: ["Backspace", "Backspace", 8],
    delete: ["Delete", "Delete", 46], arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38],
    arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40],
    arrowleft: ["ArrowLeft", "ArrowLeft", 37], left: ["ArrowLeft", "ArrowLeft", 37],
    arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
  };
  const resolved = known[normalized] ?? [key, key, key.codePointAt(0) ?? 0];
  return { key: resolved[0], code: resolved[1], keyCode: resolved[2] };
}

function parseShortcut(shortcut: string): { modifiers: number; key: string } {
  let modifiers = 0;
  let key = "";
  for (const part of shortcut.split("+")) {
    switch (part.trim().toLowerCase()) {
      case "alt": case "option": modifiers |= 1; break;
      case "ctrl": case "control": modifiers |= 2; break;
      case "meta": case "cmd": case "command": modifiers |= 4; break;
      case "shift": modifiers |= 8; break;
      default: key = part.trim();
    }
  }
  if (!key) throw browserError("browser.invalid-key", "keyboard shortcut must include a non-modifier key");
  return { modifiers, key };
}

function deviceMetrics(device: string): { width: number; height: number; deviceScaleFactor: number; mobile: boolean } {
  switch (device.toLowerCase()) {
    case "iphone 15": case "iphone": return { width: 393, height: 852, deviceScaleFactor: 3, mobile: true };
    case "pixel 8": case "android": return { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true };
    case "ipad": return { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true };
    case "desktop": return { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
    default: throw browserError("browser.invalid-device", `unknown emulation device: ${device}`);
  }
}

export class BrowserManager {
  readonly browserSession: Session;
  readonly #window: BrowserWindow;
  readonly #emitRenderer: BrowserManagerOptions["emitRenderer"];
  readonly #emitHostEvent: BrowserManagerOptions["emitHostEvent"];
  readonly #chromeImporter: ChromeImporter;
  readonly #tabs = new Map<string, TabRecord>();
  readonly #downloads = new Map<string, JsonValue>();
  #selectedTabId: string | null = null;
  #bounds: BrowserViewBounds = { x: 0, y: 0, width: 0, height: 0 };
  #visible = false;

  constructor(options: BrowserManagerOptions) {
    this.#window = options.window;
    this.#emitRenderer = options.emitRenderer;
    this.#emitHostEvent = options.emitHostEvent;
    this.#chromeImporter = options.chromeImporter;
    this.browserSession = session.fromPartition("persist:maxx-browser", { cache: true });
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.browserSession.setPermissionCheckHandler(() => false);
    const downloadRoot = path.join(options.userDataPath, "browser-downloads");
    void mkdir(downloadRoot, { recursive: true });
    this.browserSession.on("will-download", (_event, item) => {
      const id = randomUUID();
      const destination = path.join(downloadRoot, item.getFilename());
      item.setSavePath(destination);
      const publish = (state: string): void => {
        const value = asJson({ id, url: item.getURL(), filename: item.getFilename(), filePath: destination, state,
          receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
        this.#downloads.set(id, value);
        this.#emitRenderer("browser://downloads", value);
      };
      publish("inProgress");
      item.on("updated", () => publish(item.isPaused() ? "paused" : "inProgress"));
      item.once("done", (_doneEvent, state) => publish(state));
    });
  }

  setBounds(bounds: BrowserViewBounds): void {
    const finite = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    this.#bounds = {
      x: finite(bounds.x), y: finite(bounds.y),
      width: finite(bounds.width), height: finite(bounds.height),
    };
    this.#applyVisibility();
  }

  setVisible(visible: boolean): void {
    this.#visible = visible;
    this.#applyVisibility();
  }

  async execute(context: BrowserEngineContext, operation: BrowserOperation): Promise<BrowserOperationResult> {
    const result = (value: JsonValue, artifacts: BrowserOperationResult["artifacts"] = [], observationId?: string): BrowserOperationResult => ({
      tabId: context.tabId, controlEpoch: context.controlEpoch, observationId, value, artifacts,
    });
    switch (operation.operation) {
      case "open_tab": {
        const tab = this.#createTab(context.tabId);
        this.selectTab(context.tabId);
        if (operation.url) await this.#navigate(tab, validateURL(operation.url));
        return result(asJson({ url: tab.state.url, title: tab.state.title, loading: tab.state.loading, engine: "electron_web_contents" }));
      }
      case "select_tab":
        this.selectTab(context.tabId);
        return result({ selected: true });
      case "close_tab":
        this.closeTab(context.tabId);
        return result({ closed: true });
      case "navigate": {
        const tab = this.#tab(context.tabId);
        await this.#navigate(tab, validateURL(operation.url));
        return result(asJson({ url: tab.state.url, title: tab.state.title, loading: tab.state.loading }));
      }
      case "go_back": {
        const tab = this.#tab(context.tabId);
        if (tab.contents.navigationHistory.canGoBack()) {
          const ready = this.#waitForDomReady(tab);
          tab.contents.navigationHistory.goBack();
          await ready;
        }
        return result({ navigated: true });
      }
      case "go_forward": {
        const tab = this.#tab(context.tabId);
        if (tab.contents.navigationHistory.canGoForward()) {
          const ready = this.#waitForDomReady(tab);
          tab.contents.navigationHistory.goForward();
          await ready;
        }
        return result({ navigated: true });
      }
      case "reload": {
        const tab = this.#tab(context.tabId);
        const ready = this.#waitForDomReady(tab);
        tab.contents.reload();
        await ready;
        return result(asJson({ reloaded: true, url: tab.state.url, title: tab.state.title, loading: tab.state.loading }));
      }
      case "snapshot":
        return this.#snapshot(context, operation.includeScreenshot ?? false, operation.sinceObservationId ?? null);
      case "click": return result(await this.#action(context.tabId, referenceScript("click", operation.reference)));
      case "fill": return result(await this.#action(context.tabId, referenceScript("fill", operation.reference, operation.value)));
      case "press": {
        const { modifiers, key } = parseShortcut(operation.key);
        const definition = keyDefinition(key);
        const params = { modifiers, key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode };
        const tab = this.#tab(context.tabId);
        tab.agentInput = true;
        await this.#evaluate(context.tabId, "globalThis.__maxxAgentInput = true; true");
        try {
          await this.#cdp(context.tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
          if (modifiers === 0 && definition.key.length === 1) await this.#cdp(context.tabId, "Input.dispatchKeyEvent", { type: "char", text: definition.key, key: definition.key });
          await this.#cdp(context.tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
        } finally {
          await this.#evaluate(context.tabId, "globalThis.__maxxAgentInput = false; true").catch(() => null);
          tab.agentInput = false;
        }
        return result(asJson({ key: operation.key }));
      }
      case "hover": {
        const point = await this.#evaluate(context.tabId, `(() => { const el=globalThis.__maxxBrowser?.refToElement.get(${JSON.stringify(operation.reference)}); if(!el?.isConnected)return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
        if (!point || typeof point !== "object" || !("x" in point) || !("y" in point)) throw browserError("browser.stale-reference", "element reference is stale; request a fresh browser_snapshot");
        await this.#cdp(context.tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        return result(asJson({ reference: operation.reference }));
      }
      case "scroll": return result(await this.#action(context.tabId, `scrollBy(${operation.deltaX},${operation.deltaY});({ok:true})`));
      case "drag": return result(await this.#action(context.tabId, dragScript(operation.fromReference, operation.toReference)));
      case "wait": {
        const tab = this.#tab(context.tabId);
        const interruptGeneration = tab.interruptGeneration;
        const deadline = Date.now() + Math.min(60_000, operation.timeoutMs);
        while (Date.now() < deadline) {
          if (tab.interruptGeneration !== interruptGeneration) throw browserError("browser.human-takeover", "human input interrupted browser control");
          const expression = operation.condition.startsWith("text:")
            ? `document.body?.innerText.includes(${JSON.stringify(operation.condition.slice(5))}) ?? false`
            : `Boolean(${operation.condition})`;
          if (await this.#evaluate(context.tabId, expression)) return result({ matched: true });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw browserError("browser.wait-timeout", `browser condition did not match within ${operation.timeoutMs} ms`);
      }
      case "evaluate": return result(await this.#evaluate(context.tabId, operation.expression));
      case "screenshot": {
        const dataBase64 = await this.#capture(context.tabId, operation.fullPage);
        const artifact = { id: randomUUID(), uri: "maxx-browser-capture:", mimeType: "image/png", byteLength: Buffer.byteLength(dataBase64, "base64"), title: "Browser screenshot", dataBase64 };
        return result(asJson(artifact), [artifact]);
      }
      case "console_list": return result(asJson(this.#tab(context.tabId).console));
      case "console_get": {
        const entry = this.#tab(context.tabId).console.find((value) => value && typeof value === "object" && "id" in value && value.id === operation.entryId);
        if (!entry) throw browserError("browser.console-not-found", "console entry does not exist");
        return result(entry);
      }
      case "network_list": return result(asJson(this.#tab(context.tabId).network));
      case "network_get": {
        const entry = this.#tab(context.tabId).network.find((value) => value && typeof value === "object" && "id" in value && value.id === operation.requestId);
        if (!entry) throw browserError("browser.network-not-found", "network entry does not exist");
        return result(entry);
      }
      case "trace_start": {
        const tab = this.#tab(context.tabId);
        if (tab.traceChunks) throw browserError("browser.trace-active", "a trace is already active for this tab");
        tab.traceChunks = [];
        tab.traceBytes = 0;
        tab.traceOverflow = false;
        await this.#cdp(context.tabId, "Tracing.start", { transferMode: "ReportEvents", categories: "devtools.timeline,v8,blink.user_timing" });
        return result({ tracing: true });
      }
      case "trace_stop": {
        const tab = this.#tab(context.tabId);
        if (!tab.traceChunks) throw browserError("browser.trace-inactive", "no trace is active for this tab");
        const complete = this.#waitForDebuggerEvent(context.tabId, "Tracing.tracingComplete", 10_000);
        await this.#cdp(context.tabId, "Tracing.end");
        await complete;
        const trace = Buffer.from(JSON.stringify({ traceEvents: tab.traceChunks }), "utf8");
        const overflow = tab.traceOverflow;
        tab.traceChunks = null;
        tab.traceBytes = 0;
        tab.traceOverflow = false;
        if (overflow || trace.byteLength > MAX_CAPTURE_BYTES) throw browserError("browser.capture-too-large", "trace exceeded the 20 MB capture limit");
        const artifact = { id: randomUUID(), uri: "maxx-browser-trace:", mimeType: "application/json", byteLength: trace.byteLength, title: "Browser trace", dataBase64: trace.toString("base64") };
        return result(asJson(artifact), [artifact]);
      }
      case "resize":
        await this.#cdp(context.tabId, "Emulation.setDeviceMetricsOverride", { width: operation.width, height: operation.height, deviceScaleFactor: 1, mobile: false });
        return result(asJson({ width: operation.width, height: operation.height }));
      case "emulate":
        await this.#cdp(context.tabId, "Emulation.setDeviceMetricsOverride", deviceMetrics(operation.device));
        return result(asJson({ device: operation.device }));
      case "storage": return result(await this.#storage(context.tabId, operation.command, operation.value ?? null));
      case "handle_dialog":
        await this.#cdp(context.tabId, "Page.handleJavaScriptDialog", { accept: operation.accept, promptText: operation.promptText ?? undefined });
        return result(asJson({ accepted: operation.accept }));
      case "upload": {
        for (const filePath of operation.paths) {
          const resolved = path.resolve(filePath);
          if (!context.fileRoots.some((root) => resolved.startsWith(`${path.resolve(root)}${path.sep}`) || resolved === path.resolve(root))) {
            throw browserError("browser.upload-denied", "upload path is outside this session's project");
          }
        }
        const evaluated = await this.#cdp(context.tabId, "Runtime.evaluate", { expression: `globalThis.__maxxBrowser?.refToElement.get(${JSON.stringify(operation.reference)})`, returnByValue: false });
        const objectId = (evaluated as { result?: { objectId?: string } }).result?.objectId;
        if (!objectId) throw browserError("browser.stale-reference", "element reference is stale; request a fresh browser_snapshot");
        await this.#cdp(context.tabId, "DOM.setFileInputFiles", { files: operation.paths, objectId });
        return result(asJson({ paths: operation.paths }));
      }
      case "downloads": return result(asJson([...this.#downloads.values()]));
    }
  }

  selectTab(tabId: string): void {
    this.#tab(tabId);
    this.#selectedTabId = tabId;
    this.#applyVisibility();
  }

  closeTab(tabId: string): void {
    const tab = this.#tab(tabId);
    if (this.#selectedTabId === tabId) {
      this.#window.contentView.removeChildView(tab.view);
      this.#selectedTabId = [...this.#tabs.keys()].find((id) => id !== tabId) ?? null;
    }
    this.#tabs.delete(tabId);
    if (!tab.contents.isDestroyed()) tab.contents.close();
    this.#applyVisibility();
  }

  async setAnnotationMode(tabId: string, enabled: boolean): Promise<void> {
    const tab = this.#tab(tabId);
    tab.annotationEnabled = enabled;
    await this.#applyAnnotationMode(tab);
  }

  async interrupt(tabId: string): Promise<void> {
    const tab = this.#tab(tabId);
    tab.interruptGeneration += 1;
    for (const interrupt of [...tab.interruptWaiters]) interrupt();
  }

  async fillSavedPassword(tabId: string): Promise<boolean> {
    return this.#chromeImporter.fillSavedPassword(this.#tab(tabId).contents);
  }

  shutdown(): void {
    for (const tab of this.#tabs.values()) if (!tab.contents.isDestroyed()) tab.contents.close();
    this.#tabs.clear();
  }

  #createTab(tabId: string): TabRecord {
    if (this.#tabs.has(tabId)) throw browserError("browser.tab-exists", "browser tab already exists");
    const view = new WebContentsView({ webPreferences: { session: this.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const contents = view.webContents;
    view.setBackgroundColor("#ffffff");
    const record: TabRecord = { view, contents, state: { id: tabId, url: "about:blank", title: "Browser", loading: false, canGoBack: false, canGoForward: false }, generation: 0, console: [], network: [], traceChunks: null, traceBytes: 0, traceOverflow: false, agentInput: false, annotationEnabled: false, interruptGeneration: 0, interruptWaiters: new Set() };
    this.#tabs.set(tabId, record);
    this.#wireTab(record);
    return record;
  }

  #wireTab(tab: TabRecord): void {
    const contents = tab.contents;
    const update = (): void => {
      if (contents.isDestroyed()) return;
      tab.state = { ...tab.state, url: contents.getURL() || tab.state.url, title: contents.getTitle() || "Browser", canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() };
      this.#emitRenderer("browser://state", asJson(tab.state));
      this.#emitHostEvent("browser.lifecycle", asJson(tab.state));
    };
    contents.on("did-start-loading", () => { tab.state.loading = true; update(); });
    contents.on("dom-ready", () => { void this.#installPageBindings(tab); update(); });
    contents.on("did-stop-loading", () => { tab.state.loading = false; update(); });
    contents.on("did-navigate", () => { tab.generation += 1; tab.lastSnapshot = undefined; update(); });
    contents.on("did-navigate-in-page", () => update());
    contents.on("page-title-updated", (event) => { event.preventDefault(); update(); });
    contents.on("render-process-gone", (_event, details) => { tab.state.crashed = true; tab.state.loading = false; update(); this.#emitRenderer("browser://error", asJson({ tabId: tab.state.id, code: "browser.renderer-gone", message: details.reason })); });
    contents.on("before-input-event", () => {
      if (!tab.agentInput) this.#emitHostEvent("browser.human_input", asJson({ tabId: tab.state.id }));
    });
    contents.setWindowOpenHandler((details) => {
      try { void this.#navigate(tab, validateURL(details.url)); }
      catch (error) { this.#emitRenderer("browser://error", asJson({ tabId: tab.state.id, code: "browser.popup-denied", message: String(error) })); }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (url.startsWith("http://") || url.startsWith("https://")) return;
      event.preventDefault();
      this.#emitRenderer("browser://error", asJson({ tabId: tab.state.id, code: "browser.navigation-denied", message: "Only HTTP and HTTPS navigation is allowed." }));
    });
    contents.debugger.attach("1.3");
    void Promise.all([
      contents.debugger.sendCommand("Page.enable"), contents.debugger.sendCommand("Runtime.enable"),
      contents.debugger.sendCommand("DOM.enable"), contents.debugger.sendCommand("Network.enable"),
      contents.debugger.sendCommand("Runtime.addBinding", { name: HUMAN_INPUT_BINDING }),
      contents.debugger.sendCommand("Runtime.addBinding", { name: ANNOTATION_BINDING }),
    ]).catch((error) => this.#emitRenderer("browser://error", asJson({ tabId: tab.state.id, code: "browser.cdp-attach", message: String(error) })));
    contents.debugger.on("message", (_event, method, params) => this.#onDebuggerMessage(tab, method, params));
  }

  #onDebuggerMessage(tab: TabRecord, method: string, params: unknown): void {
    if (method === "Runtime.bindingCalled") {
      const binding = params as { name: string; payload: string };
      if (binding.name === HUMAN_INPUT_BINDING) this.#emitHostEvent("browser.human_input", asJson({ tabId: tab.state.id }));
      if (binding.name === ANNOTATION_BINDING) {
        const annotation = parseAnnotation(binding.payload, tab);
        if (annotation) this.#emitRenderer("browser://annotation", asJson(annotation));
      }
      return;
    }
    if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown") {
      pushBounded(tab.console, redact({ id: randomUUID(), kind: method, ...(params as object) }));
      return;
    }
    if (method.startsWith("Network.")) {
      const value = params as Record<string, unknown>;
      const id = typeof value.requestId === "string" ? value.requestId : randomUUID();
      pushBounded(tab.network, redact({ id, kind: method.slice("Network.".length), ...value }));
      return;
    }
    if (method === "Tracing.dataCollected" && tab.traceChunks) {
      const value = params as { value?: JsonValue[] };
      if (value.value && !tab.traceOverflow) {
        const bytes = Buffer.byteLength(JSON.stringify(value.value), "utf8");
        if (tab.traceBytes + bytes > MAX_CAPTURE_BYTES) tab.traceOverflow = true;
        else { tab.traceBytes += bytes; tab.traceChunks.push(...value.value); }
      }
    }
  }

  async #installPageBindings(tab: TabRecord): Promise<void> {
    const script = `(() => { if(globalThis.__maxxHumanInstalled)return; globalThis.__maxxHumanInstalled=true; const notify=(event)=>{if(event.isTrusted&&!globalThis.__maxxAgentInput)globalThis.${HUMAN_INPUT_BINDING}("input")}; for(const type of ["pointerdown","wheel","touchstart"]) addEventListener(type,notify,{capture:true,passive:true}); })()`;
    try {
      await this.#evaluate(tab.state.id, script);
      await this.#applyAnnotationMode(tab);
    } catch (error) {
      if (!this.#isExpectedNavigationRace(tab, error)) {
        this.#emitRenderer("browser://error", asJson({ tabId: tab.state.id, code: "browser.page-binding", message: String(error) }));
      }
    }
  }

  async #applyAnnotationMode(tab: TabRecord): Promise<void> {
    if (tab.contents.isDestroyed() || tab.contents.isLoadingMainFrame()) return;
    try {
      await this.#evaluate(tab.state.id, tab.annotationEnabled ? ANNOTATION_INSTALL_SCRIPT : ANNOTATION_DISABLE_SCRIPT);
    } catch (error) {
      if (!this.#isExpectedNavigationRace(tab, error)) throw error;
    }
  }

  #isExpectedNavigationRace(tab: TabRecord, error: unknown): boolean {
    return tab.contents.isDestroyed()
      || tab.contents.isLoadingMainFrame()
      || String(error).includes("Inspected target navigated or closed")
      || String(error).includes("target closed while handling command")
      || String(error).includes("webContents was destroyed");
  }

  #applyVisibility(): void {
    for (const [id, tab] of this.#tabs) {
      const shouldAttach = this.#visible && id === this.#selectedTabId && this.#bounds.width > 0 && this.#bounds.height > 0;
      const attached = this.#window.contentView.children.includes(tab.view);
      if (shouldAttach && !attached) this.#window.contentView.addChildView(tab.view);
      if (!shouldAttach && attached) this.#window.contentView.removeChildView(tab.view);
      if (shouldAttach) tab.view.setBounds(this.#bounds);
    }
  }

  #tab(tabId: string): TabRecord {
    const tab = this.#tabs.get(tabId);
    if (!tab || tab.contents.isDestroyed()) throw browserError("browser.tab-not-found", "browser tab does not exist");
    return tab;
  }

  async #navigate(tab: TabRecord, target: string): Promise<void> {
    const ready = this.#waitForDomReady(tab);
    void tab.contents.loadURL(target).catch((error) => {
      if ((error as { code?: unknown }).code === "ERR_ABORTED" || (error as { errno?: unknown }).errno === -3) return;
      this.#emitRenderer("browser://error", asJson({ tabId: tab.state.id, code: "browser.navigation-failed", message: String(error) }));
    });
    await ready;
  }

  #waitForDomReady(tab: TabRecord): Promise<void> {
    const contents = tab.contents;
    return new Promise((resolve, reject) => {
      let settled = false;
      let navigationStarted = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        contents.removeListener("did-start-navigation", onStart);
        contents.removeListener("dom-ready", onReady);
        contents.removeListener("did-fail-load", onFailure);
        tab.interruptWaiters.delete(onInterrupt);
        error ? reject(error) : resolve();
      };
      const onStart = (_event: Electron.Event, _url: string, _isInPlace: boolean, isMainFrame: boolean): void => {
        if (isMainFrame) navigationStarted = true;
      };
      const onReady = (): void => { if (navigationStarted) finish(); };
      const onFailure = (_event: Electron.Event, errorCode: number, errorDescription: string, _url: string, isMainFrame: boolean): void => {
        if (isMainFrame && errorCode !== -3) finish(browserError("browser.navigation-failed", errorDescription));
      };
      const onInterrupt = (): void => finish(browserError("browser.human-takeover", "human input interrupted browser control"));
      const timer = setTimeout(() => finish(browserError("browser.navigation-timeout", "the page did not commit within 30 seconds")), NAVIGATION_TIMEOUT_MS);
      contents.on("did-start-navigation", onStart);
      contents.on("dom-ready", onReady);
      contents.on("did-fail-load", onFailure);
      tab.interruptWaiters.add(onInterrupt);
    });
  }

  async #cdp(tabId: string, method: string, params: object = {}): Promise<unknown> {
    const contents = this.#tab(tabId).contents;
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    try { return await contents.debugger.sendCommand(method, params); }
    catch (error) { throw browserError("browser.cdp-command", `${method} failed: ${String(error)}`); }
  }

  async #evaluate(tabId: string, expression: string): Promise<JsonValue> {
    const response = await this.#cdp(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }) as { result?: { value?: JsonValue; description?: string }; exceptionDetails?: { text?: string } };
    if (response.exceptionDetails) throw browserError("browser.javascript", response.exceptionDetails.text ?? response.result?.description ?? "page expression failed");
    return response.result?.value ?? null;
  }

  async #action(tabId: string, expression: string): Promise<JsonValue> {
    const value = await this.#evaluate(tabId, expression);
    if (value && typeof value === "object" && !Array.isArray(value) && value.ok === false) {
      if (value.error === "stale") throw browserError("browser.stale-reference", "element reference is stale; request a fresh browser_snapshot");
      throw browserError("browser.action-failed", typeof value.error === "string" ? value.error : "browser action failed");
    }
    return value;
  }

  async #snapshot(context: BrowserEngineContext, includeScreenshot: boolean, since: string | null): Promise<BrowserOperationResult> {
    const tab = this.#tab(context.tabId);
    const raw = await this.#evaluate(context.tabId, SNAPSHOT_SCRIPT);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw browserError("browser.snapshot", "snapshot was not an object");
    const observationId = randomUUID();
    const value: Record<string, JsonValue> = { ...raw, observationId, documentGeneration: tab.generation, tabId: context.tabId,
      consoleErrors: tab.console.slice(-20), failedRequests: tab.network.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && entry.kind === "loadingFailed").slice(-20) };
    const full = structuredClone(value);
    if (since && tab.lastSnapshot?.id === since) {
      const previous = tab.lastSnapshot.value;
      if (previous.visibleText === value.visibleText) value.visibleText = "";
      value.incremental = true;
      value.sinceObservationId = since;
    }
    tab.lastSnapshot = { id: observationId, value: full };
    const artifacts: BrowserOperationResult["artifacts"] = [];
    if (includeScreenshot) {
      const dataBase64 = await this.#capture(context.tabId, false);
      const artifact = { id: randomUUID(), uri: "maxx-browser-capture:", mimeType: "image/png", byteLength: Buffer.byteLength(dataBase64, "base64"), title: "Browser screenshot", dataBase64 };
      artifacts.push(artifact);
      value.screenshot = asJson(artifact);
    }
    return { tabId: context.tabId, controlEpoch: context.controlEpoch, observationId, value, artifacts };
  }

  async #capture(tabId: string, fullPage: boolean): Promise<string> {
    let dataBase64: string;
    if (fullPage) {
      const metrics = await this.#cdp(tabId, "Page.getLayoutMetrics") as { cssContentSize?: { width: number; height: number }; contentSize?: { width: number; height: number } };
      const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: 1280, height: 800 };
      const width = Math.max(1, Math.ceil(size.width));
      const height = Math.max(1, Math.ceil(size.height));
      const scale = Math.min(1, Math.sqrt(MAX_CAPTURE_PIXELS / (width * height)));
      const response = await this.#cdp(tabId, "Page.captureScreenshot", {
        format: "png", captureBeyondViewport: true, optimizeForSpeed: true,
        clip: { x: 0, y: 0, width, height, scale },
      }) as { data: string };
      dataBase64 = response.data;
    } else {
      const image = await this.#tab(tabId).contents.capturePage();
      dataBase64 = image.toPNG().toString("base64");
    }
    if (Buffer.byteLength(dataBase64, "base64") > MAX_CAPTURE_BYTES) throw browserError("browser.capture-too-large", "capture exceeded the 20 MB limit");
    return dataBase64;
  }

  #waitForDebuggerEvent(tabId: string, expectedMethod: string, timeoutMs: number): Promise<unknown> {
    const debuggerClient = this.#tab(tabId).contents.debugger;
    return new Promise((resolve, reject) => {
      const listener = (_event: Electron.Event, method: string, params: unknown): void => {
        if (method !== expectedMethod) return;
        cleanup();
        resolve(params);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(browserError("browser.cdp-timeout", `${expectedMethod} did not arrive within ${timeoutMs} ms`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        debuggerClient.removeListener("message", listener);
      };
      debuggerClient.on("message", listener);
    });
  }

  async #storage(tabId: string, command: string, value: JsonValue): Promise<JsonValue> {
    if (command === "list") return this.#evaluate(tabId, "({localStorage:{...localStorage},sessionStorage:{...sessionStorage}})");
    if (command === "clear") return this.#evaluate(tabId, "localStorage.clear();sessionStorage.clear();({ok:true})");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw browserError("browser.invalid-storage", `storage ${command} requires a value object`);
    const key = typeof value.key === "string" ? value.key : null;
    if (!key) throw browserError("browser.invalid-storage", `storage ${command} requires value.key`);
    if (command === "set") {
      const area = value.area === "session" ? "sessionStorage" : "localStorage";
      return this.#evaluate(tabId, `${area}.setItem(${JSON.stringify(key)},${JSON.stringify(typeof value.value === "string" ? value.value : "")});({ok:true})`);
    }
    if (command === "remove") return this.#evaluate(tabId, `localStorage.removeItem(${JSON.stringify(key)});sessionStorage.removeItem(${JSON.stringify(key)});({ok:true})`);
    throw browserError("browser.invalid-storage", `unknown storage command: ${command}`);
  }
}
