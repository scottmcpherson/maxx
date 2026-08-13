import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  session,
  shell,
  Tray,
} from "electron";
import { BrowserManager } from "./browser-manager.js";
import { ChromeImporter } from "./chrome-importer.js";
import type { BrowserEngineContext, BrowserOperation, BrowserViewBounds, JsonValue } from "./contracts.js";
import { SidecarClient } from "./sidecar-client.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(sourceDirectory, "..");
const development = process.argv.includes("--dev");
const appSmoke = process.argv.includes("--app-smoke");
const browserSmoke = process.argv.includes("--browser-smoke");
const hermesBrowserSmoke = process.argv.includes("--hermes-browser-smoke");
const smokeMode = appSmoke || browserSmoke || hermesBrowserSmoke;
const smokeUserData = process.argv.find((argument) => argument.startsWith("--browser-smoke-user-data="))?.slice("--browser-smoke-user-data=".length);
const BEST_BUY_BENCHMARK = "https://www.bestbuy.com/site/searchpage.jsp?browsedCategory=pcmcat335400050008&id=pcat17071&qp=brand_facet%3DBrand%7EBambu+Lab%5Estorepickupstores_facet%3DStore+Availability+-+In+Store+Pickup%7E885&st=categoryid%24pcmcat335400050008";
const HERMES_SMOKE_MODEL = "custom:vllm-spark:unsloth/Qwen3.6-35B-A3B-NVFP4";

if (smokeMode) app.setPath("userData", smokeUserData || path.join(app.getPath("temp"), `maxx-browser-smoke-${process.pid}`));

protocol.registerSchemesAsPrivileged([
  { scheme: "maxx-media", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
]);

let mainWindow: BrowserWindow | null = null;
let browser: BrowserManager | null = null;
let runtime: SidecarClient | null = null;
let chromeImporter: ChromeImporter | null = null;
let tray: Tray | null = null;
let quitting = false;
const authorizedMedia = new Set<string>();
const RUNTIME_METHODS = new Set([
  "workspace_snapshot", "active_turns", "add_project", "remove_project", "add_thread",
  "add_thread_with_runtime", "remove_thread", "update_thread", "update_profiles",
  "update_title_generation_runtime", "update_agents", "import_agent_image", "send_prompt",
  "start_side_thread", "send_agent_prompt", "cancel_turn", "resolve_request", "provider_health",
  "list_provider_models", "resolve_media_source", "voice_status", "update_voice_settings",
  "voice_start", "voice_send_audio", "voice_stop", "browser_ui_tabs", "browser_ui_open_tab",
  "browser_ui_select_tab", "browser_ui_close_tab", "browser_ui_reorder_tabs", "browser_ui_navigate", "browser_ui_back",
  "browser_ui_forward", "browser_ui_reload", "browser_ui_artifact",
]);

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function emitRenderer(event: string, payload: JsonValue): void {
  const window = mainWindow;
  if (window && !window.isDestroyed()) window.webContents.send(`maxx:event:${event}`, payload);
}

function runtimeExecutable(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "bin", "maxx-runtime");
  return path.join(projectDirectory, "src-tauri", "target", "debug", "maxx");
}

function runtimeWorkingDirectory(): string {
  return app.isPackaged ? process.resourcesPath : projectDirectory;
}

function registerMediaProtocol(): void {
  protocol.handle("maxx-media", (request) => {
    const encoded = new URL(request.url).pathname.replace(/^\//, "");
    let filePath = "";
    try { filePath = Buffer.from(encoded, "base64url").toString("utf8"); } catch { return new Response("Bad path", { status: 400 }); }
    const resolved = path.resolve(filePath);
    const localMediaRoots = [path.join(app.getPath("userData"), "agent-images"), path.join(app.getPath("userData"), "chat-images")];
    if (!authorizedMedia.has(resolved) && !localMediaRoots.some((root) => isInside(resolved, root))) {
      return new Response("Not authorized", { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

function installMenu(toggleSidebar?: string | null, toggleBrowser?: string | null): void {
  const send = (id: string): void => emitRenderer("menu://action", { id });
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "appMenu", submenu: [
      { label: "About Maxx", role: "about" }, { type: "separator" },
      { label: "Settings…", accelerator: "CommandOrControl+,", click: () => send("settings") },
      { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" }, { role: "quit" },
    ] },
    { label: "File", submenu: [
      { label: "New Chat", accelerator: "CommandOrControl+N", click: () => send("new_thread") },
      { label: "Search", accelerator: "CommandOrControl+K", click: () => send("search") },
      { type: "separator" }, { role: "close" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { label: "Toggle Sidebar", accelerator: toggleSidebar || undefined, click: () => send("toggle_sidebar") },
      { label: "Toggle Browser", accelerator: toggleBrowser || undefined, click: () => send("toggle_browser") },
      { type: "separator" },
      { label: "Zoom In", accelerator: "CommandOrControl+Plus", click: () => send("zoom_in") },
      { label: "Zoom Out", accelerator: "CommandOrControl+-", click: () => send("zoom_out") },
      { label: "Actual Size", accelerator: "CommandOrControl+0", click: () => send("zoom_reset") },
      { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trayIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "assets", "tray.png")
    : path.join(projectDirectory, "src-tauri", "icons", "tray.png");
}

function installTray(): void {
  const icon = nativeImage.createFromPath(trayIconPath());
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Maxx");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Maxx", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: "New Chat", click: () => { mainWindow?.show(); emitRenderer("menu://action", { id: "new_thread" }); } },
    { label: "Settings…", click: () => { mainWindow?.show(); emitRenderer("menu://action", { id: "settings" }); } },
    { type: "separator" },
    { label: "Quit Maxx", click: () => app.quit() },
  ]));
  tray.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
}

async function createWindow(): Promise<void> {
  const preload = path.join(sourceDirectory, "preload.cjs");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Maxx",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 15 },
    backgroundColor: "#1c1c1e",
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = development ? url.startsWith("http://localhost:1420") : url.startsWith("file:");
    if (!allowed) event.preventDefault();
  });
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    browser?.setVisible(false);
    mainWindow?.hide();
  });
  const persistentBrowserSession = session.fromPartition("persist:maxx-browser", { cache: true });
  chromeImporter = new ChromeImporter(persistentBrowserSession, app.getPath("userData"));
  browser = new BrowserManager({
    window: mainWindow,
    userDataPath: app.getPath("userData"),
    emitRenderer,
    emitHostEvent: (event, payload) => runtime?.event(event, payload),
    chromeImporter,
  });
  const executable = runtimeExecutable();
  if (!existsSync(executable)) throw new Error(`Maxx runtime is missing at ${executable}; build it with cargo build --manifest-path src-tauri/Cargo.toml`);
  runtime = new SidecarClient({
    executable,
    cwd: runtimeWorkingDirectory(),
    onEvent: (event, payload) => {
      if (event === "notification://turn-finished") {
        const value = payload as { title?: unknown; terminalState?: unknown };
        if (!mainWindow?.isFocused() && Notification.isSupported()) {
          new Notification({ title: "Maxx", body: typeof value.title === "string" ? `${value.title} finished` : "Agent turn finished" }).show();
        }
        return;
      }
      emitRenderer(event, payload);
    },
    onHostRequest: async (method, params) => {
      if (method === "browser.execute") {
        const value = params as unknown as { context: BrowserEngineContext; operation: BrowserOperation };
        return browser!.execute(value.context, value.operation) as unknown as JsonValue;
      }
      if (method === "browser.interrupt") {
        await browser!.interrupt(String((params as { tabId?: unknown }).tabId));
        return null;
      }
      throw Object.assign(new Error(`Unknown host method ${method}`), { code: "host.unknown-method" });
    },
    onLog: (line) => console.error(`[maxx-runtime] ${line}`),
  });
  if (development) await mainWindow.loadURL("http://localhost:1420");
  else await mainWindow.loadFile(path.join(projectDirectory, "dist", "index.html"));
}

async function runAppSmoke(): Promise<void> {
  registerMediaProtocol();
  registerIPC();
  installMenu();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  await createWindow();
  const deadline = Date.now() + 15_000;
  let state: { bridge: boolean; newChat: boolean; projects: boolean } = { bridge: false, newChat: false, projects: false };
  while (Date.now() < deadline) {
    state = await mainWindow!.webContents.executeJavaScript(`({
      bridge: typeof globalThis.maxx?.invoke === "function" && typeof globalThis.maxx?.listen === "function",
      newChat: document.body.innerText.includes("New chat"),
      projects: document.body.innerText.includes("Projects")
    })`) as typeof state;
    if (state.bridge && state.newChat && state.projects) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!state.bridge || !state.newChat || !state.projects) throw new Error(`packaged renderer did not become ready: ${JSON.stringify(state)}`);
  process.stdout.write(`MAXX_APP_SMOKE ${JSON.stringify({ ok: true, ...state })}\n`);
}

async function runBrowserSmoke(): Promise<void> {
  let stage = "fixture server";
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>Maxx Browser Acceptance</title><main><h1>Maxx Browser Test</h1><label>Store <input aria-label='Store'></label><button onclick=\"document.querySelector('#status').textContent='Selected: '+document.querySelector('input').value\">Select store</button><p id='status'>Waiting for selection</p></main>");
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", () => resolve());
  });
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Browser fixture did not bind to TCP");
  const fixtureURL = `http://127.0.0.1:${address.port}/`;
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.showInactive();
  const errors: JsonValue[] = [];
  const importer = new ChromeImporter(session.fromPartition("persist:maxx-browser", { cache: true }), app.getPath("userData"));
  const manager = new BrowserManager({
    window,
    userDataPath: app.getPath("userData"),
    emitRenderer: (event, payload) => { if (event === "browser://error") errors.push(payload); },
    emitHostEvent: () => undefined,
    chromeImporter: importer,
  });
  manager.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
  manager.setVisible(true);
  const tabId = randomUUID();
  const context: BrowserEngineContext = { sessionId: randomUUID(), actionId: randomUUID(), tabId, controlEpoch: 0, fileRoots: [projectDirectory] };
  const run = (operation: BrowserOperation) => manager.execute({ ...context, actionId: randomUUID() }, operation);
  const observed: Array<{ url: string; title: string; textLength: number }> = [];
  const observe = async (url: string): Promise<Record<string, JsonValue>> => {
    await run({ operation: "navigate", tabId, url });
    await run({ operation: "wait", tabId, condition: "document.readyState !== 'loading'", timeoutMs: 15_000 });
    const snapshot = await run({ operation: "snapshot", tabId, includeScreenshot: false });
    const value = snapshot.value as Record<string, JsonValue>;
    observed.push({ url: String(value.url ?? ""), title: String(value.title ?? ""), textLength: String(value.visibleText ?? "").length });
    return value;
  };
  try {
    stage = "open tab";
    await run({ operation: "open_tab", url: null });
    stage = "fixture snapshot";
    const interactive = await observe(fixtureURL);
    const elements = Array.isArray(interactive.elements) ? interactive.elements as Array<Record<string, JsonValue>> : [];
    const input = elements.find((element) => element.role === "textbox");
    const button = elements.find((element) => element.role === "button" && element.name === "Select store");
    if (typeof input?.reference !== "string" || typeof button?.reference !== "string") throw new Error("Semantic snapshot omitted the fixture controls");
    stage = "fixture fill";
    await run({ operation: "fill", tabId, reference: input.reference, value: "Spring Hill" });
    stage = "fixture click";
    await run({ operation: "click", tabId, reference: button.reference });
    const status = await run({ operation: "evaluate", tabId, expression: "document.querySelector('#status')?.textContent ?? ''" });
    if (status.value !== "Selected: Spring Hill") throw new Error("DOM interactions did not affect the visible tab");
    stage = "Google";
    await observe("https://www.google.com/");
    stage = "Facebook";
    await observe("https://www.facebook.com/");
    stage = "Best Buy";
    const bestBuy = await observe(BEST_BUY_BENCHMARK);
    if (String(bestBuy.url ?? "").length === 0 || String(bestBuy.title ?? "").length === 0) throw new Error("Best Buy did not commit a document");
    stage = "same-tab screenshot";
    const capture = await run({ operation: "screenshot", tabId, fullPage: true });
    const bytes = capture.artifacts[0]?.byteLength ?? 0;
    if (bytes <= 0 || bytes > 20 * 1024 * 1024) throw new Error("Same-tab screenshot was missing or unbounded");
    const persistenceCookie = await manager.browserSession.cookies.get({ url: "https://example.com/", name: "maxx-browser-smoke" });
    const persistedBefore = persistenceCookie.some((cookie) => cookie.value === "preserved");
    await manager.browserSession.cookies.set({ url: "https://example.com/", name: "maxx-browser-smoke", value: "preserved", secure: true, sameSite: "lax", expirationDate: Date.now() / 1000 + 3600 });
    await manager.browserSession.flushStorageData();
    stage = "close and reopen during annotation cleanup";
    const annotationCleanup = manager.setAnnotationMode(tabId, false);
    manager.closeTab(tabId);
    await annotationCleanup;
    const replacementTabId = randomUUID();
    const replacement = await manager.execute(
      { ...context, tabId: replacementTabId, actionId: randomUUID() },
      { operation: "open_tab", url: null },
    );
    const tabLifecycleRecovered = replacement.tabId === replacementTabId;
    if (!tabLifecycleRecovered) throw new Error("browser did not recover after the final tab closed during annotation cleanup");
    process.stdout.write(`MAXX_BROWSER_SMOKE ${JSON.stringify({ ok: true, tabId, observed, screenshotBytes: bytes, persistedBefore, tabLifecycleRecovered, errors })}\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(`${stage}: ${detail}`);
  } finally {
    manager.shutdown();
    window.destroy();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}

async function runHermesBrowserSmoke(): Promise<void> {
  const escapedBenchmark = BEST_BUY_BENCHMARK.replaceAll("&", "&amp;").replaceAll("'", "&#39;");
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>Maxx Hermes Browser Acceptance</title><main><h1>Maxx Browser Test</h1><label>Store <input aria-label='Store'></label><button onclick="document.querySelector('#status').textContent='Selected: '+document.querySelector('input').value">Select store</button><p id='status'>Waiting for selection</p><a href='${escapedBenchmark}'>Open exact Best Buy benchmark</a></main>`);
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", () => resolve());
  });
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Hermes fixture did not bind to TCP");
  const fixtureURL = `http://127.0.0.1:${address.port}/`;
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.showInactive();
  const importer = new ChromeImporter(session.fromPartition("persist:maxx-browser", { cache: true }), app.getPath("userData"));
  let client: SidecarClient;
  let hostArtifactCount = 0;
  const hostOperations: string[] = [];
  const hostTabIds = new Set<string>();
  const hostURLs: string[] = [];
  const lifecycleURLs: string[] = [];
  const finishEvents: Array<Record<string, JsonValue>> = [];
  let finishTurnId: string | null = null;
  let finishResolve: (() => void) | null = null;
  const manager = new BrowserManager({
    window,
    userDataPath: app.getPath("userData"),
    emitRenderer: (event, payload) => {
      if (event === "browser://state" && payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.url === "string") {
        lifecycleURLs.push(payload.url);
      }
    },
    emitHostEvent: (event, payload) => client?.event(event, payload),
    chromeImporter: importer,
  });
  manager.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
  manager.setVisible(true);
  client = new SidecarClient({
    executable: runtimeExecutable(),
    cwd: runtimeWorkingDirectory(),
    onEvent: (event, payload) => {
      if (event !== "turn://finished" || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
      finishEvents.push(payload);
      if (finishTurnId && payload.turnID === finishTurnId) finishResolve?.();
    },
    onHostRequest: async (method, params) => {
      if (method === "browser.execute") {
        const value = params as unknown as { context: BrowserEngineContext; operation: BrowserOperation };
        const result = await manager.execute(value.context, value.operation);
        hostOperations.push(value.operation.operation);
        hostTabIds.add(value.context.tabId);
        if ((value.operation.operation === "open_tab" || value.operation.operation === "navigate") && value.operation.url) hostURLs.push(value.operation.url);
        hostArtifactCount += result.artifacts.length;
        return result as unknown as JsonValue;
      }
      if (method === "browser.interrupt") {
        await manager.interrupt(String((params as { tabId?: unknown }).tabId));
        return null;
      }
      throw Object.assign(new Error(`Unknown host method ${method}`), { code: "host.unknown-method" });
    },
    onLog: (line) => process.stderr.write(`[maxx-runtime] ${line}\n`),
  });
  let projectId: string | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  try {
    const initial = await client.request("workspace_snapshot", {}, 30_000) as Record<string, JsonValue>;
    const projects = Array.isArray(initial.projects) ? initial.projects as Array<Record<string, JsonValue>> : [];
    const project = projects.find((value) => typeof value.folderPath === "string" && path.basename(value.folderPath) === "maxx-tauri");
    if (!project || typeof project.id !== "string") throw new Error("The maxx-tauri project is not present in the Maxx workspace");
    projectId = project.id;
    const thread = await client.request("add_thread_with_runtime", {
      projectId, provider: "hermes", model: HERMES_SMOKE_MODEL, title: "Hermes Qwen browser acceptance", effort: null, speed: null,
    }, 30_000) as Record<string, JsonValue>;
    if (typeof thread.id !== "string") throw new Error("Hermes smoke thread was not created");
    threadId = thread.id;
    const prompt = [
      "Run a browser acceptance test using only the Maxx browser tools and one tab.",
      `1. Open ${fixtureURL}`,
      "2. Snapshot it, fill the Store textbox with Spring Hill, click Select store, and verify the page says Selected: Spring Hill.",
      "3. In that same tab, click the link named Open exact Best Buy benchmark. Its DOM href already contains the exact required URL; do not retype or rewrite it.",
      "4. Snapshot the Best Buy page with includeScreenshot=true.",
      "5. Reply with the fixture status, Best Buy page title, final URL, and whether the screenshot succeeded. Do not skip any browser action.",
    ].join("\n");
    turnId = await client.request("send_prompt", { projectId, threadId, prompt, imagePaths: [] }, 30_000) as string;
    finishTurnId = turnId;
    const alreadyFinished = finishEvents.some((event) => event.turnID === turnId);
    if (!alreadyFinished) {
      await new Promise<void>((resolve, reject) => {
        finishResolve = resolve;
        const timer = setTimeout(() => reject(new Error("Hermes browser turn did not finish within 5 minutes")), 300_000);
        const settled = resolve;
        finishResolve = () => { clearTimeout(timer); settled(); };
      });
    }
    const completed = finishEvents.find((event) => event.turnID === turnId);
    if (completed?.terminalState !== "completed") throw new Error(`Hermes turn ended as ${String(completed?.terminalState ?? "unknown")}`);
    const finalWorkspace = await client.request("workspace_snapshot", {}, 30_000) as Record<string, JsonValue>;
    const finalProjects = finalWorkspace.projects as Array<Record<string, JsonValue>>;
    const finalProject = finalProjects.find((value) => value.id === projectId);
    const finalThread = (finalProject?.threads as Array<Record<string, JsonValue>> | undefined)?.find((value) => value.id === threadId);
    if (!finalThread || finalThread.model !== HERMES_SMOKE_MODEL) throw new Error("Hermes smoke did not run on the requested Unsloth/Qwen3.6 model");
    const runtimeEvents = Array.isArray(finalThread.runtimeEvents) ? finalThread.runtimeEvents as Array<Record<string, JsonValue>> : [];
    const toolEvents = runtimeEvents.filter((event) => event.kind === "tool");
    const toolNames = [...new Set(toolEvents.map((event) => {
      const payload = event.payload as Record<string, JsonValue> | undefined;
      const tool = payload?.tool as Record<string, JsonValue> | undefined;
      return typeof tool?.name === "string" ? tool.name : "";
    }).filter(Boolean))];
    // browser_open returns the first semantic observation and browser_act
    // returns a fresh one after its guarded action batch, so an extra explicit
    // browser_observe call is optional.
    for (const required of ["browser_open", "browser_act"]) {
      if (!toolNames.some((name) => name.endsWith(required))) throw new Error(`Hermes did not call ${required}; observed ${toolNames.join(", ")}`);
    }
    if (!toolNames.some((name) => name.endsWith("browser_screenshot") || name.endsWith("browser_observe"))) {
      throw new Error(`Hermes did not request screenshot evidence; observed ${toolNames.join(", ")}`);
    }
    const visitedURLs = [...new Set([...hostURLs, ...lifecycleURLs])];
    if (!visitedURLs.includes(BEST_BUY_BENCHMARK)) throw new Error(`Hermes did not commit the exact Best Buy benchmark URL; host saw ${visitedURLs.join(", ")}`);
    const timelineArtifactCount = runtimeEvents.reduce((count, event) => {
      const payload = event.payload as Record<string, JsonValue> | undefined;
      return count + (Array.isArray(payload?.artifacts) ? payload.artifacts.length : 0);
    }, 0);
    if (hostArtifactCount === 0) throw new Error("Hermes did not persist a browser screenshot artifact");
    if (hostTabIds.size !== 1) throw new Error(`Hermes used ${hostTabIds.size} Chromium tabs instead of one same-tab flow`);
    const messages = Array.isArray(finalThread.messages) ? finalThread.messages as Array<Record<string, JsonValue>> : [];
    const finalMessage = [...messages].reverse().find((message) => message.role === "assistant");
    process.stdout.write(`MAXX_HERMES_BROWSER_SMOKE ${JSON.stringify({ ok: true, model: HERMES_SMOKE_MODEL, toolNames, hostOperations, visitedURLs, tabCount: hostTabIds.size, artifactCount: hostArtifactCount, timelineArtifactCount, response: String(finalMessage?.content ?? "").slice(0, 1_000) })}\n`);
  } finally {
    if (turnId) await client.request("cancel_turn", { turnId }, 10_000).catch(() => null);
    if (projectId && threadId) await client.request("remove_thread", { projectId, threadId }, 10_000).catch(() => null);
    client.shutdown();
    manager.shutdown();
    window.destroy();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}

function registerIPC(): void {
  ipcMain.handle("maxx:invoke", async (event, method: string, rawParams: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("IPC sender is not the Maxx application window");
    if (typeof method !== "string") throw new Error("IPC method must be a string");
    const params = (rawParams ?? {}) as Record<string, unknown>;
    switch (method) {
      case "browser_view_bounds":
        browser?.setBounds(params.bounds as BrowserViewBounds);
        return null;
      case "browser_view_visible":
        browser?.setVisible(Boolean(params.visible));
        return null;
      case "browser_annotation_mode":
        await browser?.setAnnotationMode(String(params.tabId), Boolean(params.enabled));
        return null;
      case "browser_chrome_import_status":
        return chromeImporter?.status();
      case "browser_import_chrome":
        return chromeImporter?.import(String(params.profileId));
      case "browser_fill_saved_password":
        return browser?.fillSavedPassword(String(params.tabId)) ?? false;
      case "dialog_open_project": {
        const result = await dialog.showOpenDialog(mainWindow!, { title: "Open project folder", properties: ["openDirectory"] });
        return result.canceled ? null : result.filePaths[0] ?? null;
      }
      case "dialog_open_images": {
        const result = await dialog.showOpenDialog(mainWindow!, { title: "Choose images", properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
        for (const filePath of result.filePaths) authorizedMedia.add(path.resolve(filePath));
        return result.canceled ? [] : result.filePaths;
      }
      case "dialog_open_agent_image": {
        const result = await dialog.showOpenDialog(mainWindow!, { title: "Choose an image", properties: ["openFile"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
        for (const filePath of result.filePaths) authorizedMedia.add(path.resolve(filePath));
        return result.canceled ? null : result.filePaths[0] ?? null;
      }
      case "authorize_image_previews":
        // The picker already authorized every path it returned. Keeping this
        // acknowledgement preserves the async attachment flow without
        // accepting arbitrary renderer-supplied file paths.
        return null;
      case "window_toggle_maximize":
        if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize();
        return null;
      case "set_shortcut_accelerators":
        installMenu(typeof params.toggleSidebar === "string" ? params.toggleSidebar : null, typeof params.toggleBrowser === "string" ? params.toggleBrowser : null);
        return null;
      case "check_for_updates":
        return { state: "unavailable", message: "Updates are unavailable in local builds." };
      default: {
        if (!RUNTIME_METHODS.has(method)) throw new Error(`IPC method is not allowed: ${method}`);
        if (!runtime) throw new Error("Maxx runtime is not ready");
        const value = await runtime.request(method, (params as unknown) as JsonValue);
        if (method === "resolve_media_source" && value && typeof value === "object" && !Array.isArray(value) && typeof value.path === "string") {
          authorizedMedia.add(path.resolve(value.path));
        }
        if (method === "import_agent_image" && typeof value === "string") authorizedMedia.add(path.resolve(value));
        return value;
      }
    }
  });
}

if (!smokeMode && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    if (appSmoke) {
      try { await runAppSmoke(); }
      catch (error) { process.stderr.write(`MAXX_APP_SMOKE_FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; }
      browser?.shutdown();
      browser = null;
      mainWindow?.destroy();
      mainWindow = null;
      runtime?.shutdown();
      runtime = null;
      app.quit();
      return;
    }
    if (browserSmoke) {
      try { await runBrowserSmoke(); }
      catch (error) { process.stderr.write(`MAXX_BROWSER_SMOKE_FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; }
      app.quit();
      return;
    }
    if (hermesBrowserSmoke) {
      try { await runHermesBrowserSmoke(); }
      catch (error) { process.stderr.write(`MAXX_HERMES_BROWSER_SMOKE_FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; }
      app.quit();
      return;
    }
    registerMediaProtocol();
    registerIPC();
    installMenu();
    installTray();
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(permission === "media" && contents === mainWindow?.webContents);
    });
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(path.join(projectDirectory, "src-tauri", "icons", "128x128.png")));
    await createWindow();
    app.on("activate", () => { if (!mainWindow) void createWindow(); else mainWindow.show(); });
  }).catch((error) => { dialog.showErrorBox("Maxx could not start", String(error)); app.quit(); });
  app.on("before-quit", () => { quitting = true; browser?.shutdown(); runtime?.shutdown(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
