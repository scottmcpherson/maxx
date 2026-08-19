import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
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
import { buildInstanceSettings } from "./build-instance.js";
import { ChromeImporter } from "./chrome-importer.js";
import type { BrowserAnnotationSelection, BrowserEngineContext, BrowserOperation, BrowserViewBounds, JsonValue } from "./contracts.js";
import { SidecarClient } from "./sidecar-client.js";
import { MaxxUpdater } from "./updater.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(sourceDirectory, "..");
const development = process.argv.includes("--dev");
const checkoutBuild = process.argv.includes("--checkout-build");
const appSmoke = process.argv.includes("--app-smoke");
const browserSmoke = process.argv.includes("--browser-smoke");
const hermesBrowserSmoke = process.argv.includes("--hermes-browser-smoke");
// Manual, isolated app session used by Computer Use to exercise the real
// terminal UI without touching the user's normal Maxx workspace.
const terminalUiSmoke = process.argv.includes("--terminal-ui-smoke");
const terminalUiProject = process.argv.find((argument) => argument.startsWith("--terminal-ui-project="))
  ?.slice("--terminal-ui-project=".length) || process.cwd();
const smokeMode = appSmoke || browserSmoke || hermesBrowserSmoke || terminalUiSmoke;
const smokeUserData = process.argv.find((argument) => argument.startsWith("--browser-smoke-user-data="))?.slice("--browser-smoke-user-data=".length);
const BEST_BUY_BENCHMARK = "https://www.bestbuy.com/site/searchpage.jsp?browsedCategory=pcmcat335400050008&id=pcat17071&qp=brand_facet%3DBrand%7EBambu+Lab%5Estorepickupstores_facet%3DStore+Availability+-+In+Store+Pickup%7E885&st=categoryid%24pcmcat335400050008";
const HERMES_SMOKE_MODEL = "custom:vllm-spark:unsloth/Qwen3.6-35B-A3B-NVFP4";
const SMOKE_ANNOTATION_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const buildInstance = buildInstanceSettings(
  app.getPath("appData"),
  app.getName(),
  projectDirectory,
  development,
  checkoutBuild,
);

if (smokeMode) app.setPath("userData", smokeUserData || path.join(app.getPath("temp"), `maxx-browser-smoke-${process.pid}`));
else if (buildInstance.userDataPath) app.setPath("userData", buildInstance.userDataPath);

protocol.registerSchemesAsPrivileged([
  { scheme: "maxx-media", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
]);

let mainWindow: BrowserWindow | null = null;
let browser: BrowserManager | null = null;
let runtime: SidecarClient | null = null;
let chromeImporter: ChromeImporter | null = null;
let tray: Tray | null = null;
let updater: MaxxUpdater | null = null;
let quitting = false;
const authorizedMedia = new Set<string>();
const RUNTIME_METHODS = new Set([
  "workspace_snapshot", "active_turns", "git_status", "git_branches", "git_checkout", "git_create_branch", "git_commit", "git_push",
  "list_automations", "create_automation", "update_automation", "delete_automation", "run_automation",
  "add_project", "remove_project", "add_thread", "add_chat",
  "add_thread_with_runtime", "remove_thread", "update_thread", "update_profiles",
  "update_title_generation_runtime", "update_agents", "import_agent_image", "send_prompt",
  "create_side_chat", "start_side_thread", "send_agent_prompt", "steer_prompt", "cancel_turn", "resolve_request", "provider_health",
  "terminal_support", "terminal_start", "terminal_status", "terminal_input", "terminal_resize",
  "terminal_read", "terminal_stop", "shell_terminal_start", "shell_terminal_status",
  "shell_terminal_input", "shell_terminal_resize", "shell_terminal_read", "shell_terminal_stop",
  "list_provider_models", "list_provider_commands", "resolve_media_source", "voice_status", "voice_test_stt", "voice_list_models", "voice_list_voices", "update_voice_settings",
  "voice_start", "voice_send_audio", "voice_stop", "voice_interrupt_turn", "voice_tts_start", "voice_tts_read", "voice_tts_cancel", "browser_ui_tabs", "browser_ui_open_tab",
  "browser_ui_select_tab", "browser_ui_close_tab", "browser_ui_reorder_tabs", "browser_ui_navigate", "browser_ui_back",
  "browser_ui_forward", "browser_ui_reload", "browser_ui_artifact",
  "host_status", "host_discovery", "host_listen", "host_unlisten", "host_create_pairing",
  "host_cancel_pairing", "host_connect", "host_disconnect", "host_revoke_peer",
  "list_folder", "create_folder", "home_folder", "upload_media", "read_media", "load_media",
]);

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function emitRenderer(event: string, payload: JsonValue): void {
  const window = mainWindow;
  if (window && !window.isDestroyed()) window.webContents.send(`maxx:event:${event}`, payload);
}

async function initializeUpdater(): Promise<void> {
  updater = new MaxxUpdater(
    (status) => emitRenderer("updater://status", status),
    () => { quitting = true; },
    app.isPackaged && !buildInstance.userDataPath,
    app.getVersion(),
  );
  await updater.initialize();
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
      { label: "Check for Updates…", click: () => void updater?.checkForUpdates(true) },
      { type: "separator" },
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
      ...(development ? [
        { type: "separator" as const },
        {
          label: "Toggle Developer Tools",
          accelerator: process.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
      ] : []),
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
    dataDirectory: app.getPath("userData"),
    environment: buildInstance.listenPort ? { MAXX_LISTEN_PORT: buildInstance.listenPort } : undefined,
    onEvent: (event, payload) => {
      if (event === "notification://automation") {
        const value = payload as { title?: unknown; body?: unknown };
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: typeof value.title === "string" && value.title ? value.title : "Maxx Automation",
            body: typeof value.body === "string" ? value.body : "An automation finished",
          });
          notification.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
          notification.show();
        }
        emitRenderer(event, payload);
        return;
      }
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
  const clipboardProbe = `maxx-app-smoke-${Date.now()}`;
  await mainWindow!.webContents.executeJavaScript(
    `globalThis.maxx.invoke("clipboard_write_text", ${JSON.stringify({ text: clipboardProbe })})`,
  );
  if (clipboard.readText() !== clipboardProbe) throw new Error("packaged clipboard bridge did not write the expected text");
  const emptyChatDeadline = Date.now() + 10_000;
  let emptyChatUI = { heading: "", chooseProject: false, environment: false, branch: false };
  while (Date.now() < emptyChatDeadline) {
    emptyChatUI = await mainWindow!.webContents.executeJavaScript(`(() => ({
      heading: document.querySelector('.new-agent-heading')?.textContent?.trim() ?? '',
      chooseProject: Boolean(document.querySelector('[aria-label="Choose project"]')),
      environment: Boolean(document.querySelector('[aria-label="Choose where to work"]')),
      branch: Boolean(document.querySelector('[aria-label="Choose branch"]'))
    }))()`) as typeof emptyChatUI;
    if (emptyChatUI.heading && emptyChatUI.chooseProject) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (emptyChatUI.heading !== "What should we work on?" || !emptyChatUI.chooseProject
    || emptyChatUI.environment || emptyChatUI.branch) {
    throw new Error(`empty projectless composer did not render correctly: ${JSON.stringify(emptyChatUI)}`);
  }
  const voicePlayback = await mainWindow!.webContents.executeJavaScript(`(async () => {
    const context = new AudioContext();
    try {
      const buffer = context.createBuffer(1, 160, 16000);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start();
      source.stop();
      return Boolean(buffer && source);
    } finally {
      await context.close();
    }
  })()`);
  if (voicePlayback !== true) throw new Error("packaged voice playback primitives were unavailable");
  const voiceSettingsUI = await mainWindow!.webContents.executeJavaScript(`(async () => {
    const waitFor = async (probe, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = probe();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    };
    const settingsButton = [...document.querySelectorAll('.sidebar-footer button')]
      .find((button) => button.textContent?.includes('Settings'));
    settingsButton?.click();
    const voiceButton = await waitFor(() => [...document.querySelectorAll('[aria-label="Settings sections"] button')]
      .find((button) => button.textContent?.includes('Voice')));
    voiceButton?.click();
    const panel = await waitFor(() => document.querySelector('[aria-label="Voice settings"]'));
    const result = Boolean(
      panel
      && document.querySelector('[aria-label="Enable voice input"]')
      && document.querySelector('[aria-label="Voice mode"]')
      && document.querySelector('[aria-label="Text-to-speech voice"]')
      && document.querySelector('[aria-label="Voice turn detection"]')
    );
    document.querySelector('.settings-back')?.click();
    return result;
  })()`);
  if (voiceSettingsUI !== true) throw new Error("packaged Voice settings controls did not render");
  const initial = await runtime!.request("workspace_snapshot", {}, 5_000) as Record<string, JsonValue>;
  if (!Array.isArray(initial.projects) || initial.projects.length !== 0) throw new Error("smoke runtime was not isolated from the user's workspace");
  const automation = await runtime!.request("create_automation", {
    title: "Packaged automation acceptance",
    kind: "notification",
    prompt: "Automation delivery verified",
    schedule: {
      type: "once",
      at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      timezone: "UTC",
    },
    runtime: null,
  }, 5_000) as Record<string, JsonValue>;
  const automationId = String(automation.id ?? "");
  if (!automationId || automation.status !== "active") throw new Error(`automation creation failed: ${JSON.stringify(automation)}`);
  await runtime!.request("run_automation", { id: automationId }, 5_000);
  let automationSmoke: Record<string, JsonValue> | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const schedules = await runtime!.request("list_automations", {}, 5_000) as Array<Record<string, JsonValue>>;
    automationSmoke = schedules.find((candidate) => candidate.id === automationId);
    const lastRun = automationSmoke?.lastRun as Record<string, JsonValue> | undefined;
    if (lastRun?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const automationLastRun = automationSmoke?.lastRun as Record<string, JsonValue> | undefined;
  if (automationLastRun?.status !== "completed" || automationSmoke?.status !== "active") {
    throw new Error(`automation run-now failed: ${JSON.stringify(automationSmoke)}`);
  }
  await runtime!.request("delete_automation", { id: automationId }, 5_000);
  // Exercise Git-backed UI against the caller's checkout. A packaged app's
  // resources directory happens to sit under this repository in local builds,
  // but it lives on a read-only, non-Git volume after mounting a downloaded DMG.
  const project = await runtime!.request("add_project", { folderPath: process.cwd() }, 5_000) as Record<string, JsonValue>;
  const projectId = String(project.id ?? "");
  const thread = await runtime!.request("add_thread", {
    projectId,
    provider: "hermes",
    model: HERMES_SMOKE_MODEL,
    title: "Packaged runtime acceptance",
  }, 5_000) as Record<string, JsonValue>;
  const threadId = String(thread.id ?? "");
  const gitStatus = await runtime!.request("git_status", { projectId }, 15_000) as Record<string, JsonValue> | null;
  if (!gitStatus || typeof gitStatus.repositoryRoot !== "string" || !Array.isArray(gitStatus.files)) {
    throw new Error("packaged runtime did not expose Git status for its repository project");
  }
  const reloaded = new Promise<void>((resolve) => mainWindow!.webContents.once("did-finish-load", () => resolve()));
  mainWindow!.webContents.reload();
  await reloaded;
  const gitDeadline = Date.now() + 15_000;
  let gitUI = {
    rail: false,
    environment: false,
    changes: false,
    action: false,
    trigger: false,
    popup: false,
    dialog: false,
    generatedMessageHint: false,
    includeUnstagedChanges: false,
    dialogActions: false,
    manualRefresh: false,
    counts: "",
  };
  while (Date.now() < gitDeadline) {
    gitUI = await mainWindow!.webContents.executeJavaScript(`(() => {
      const rail = document.querySelector('.context-rail');
      const environment = rail?.querySelector('.git-environment-section');
      const text = environment?.textContent ?? '';
      const action = Array.from(environment?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent?.includes('Commit or push'));
      if (action && !document.querySelector('.git-commit-dialog')) action.click();
      const dialog = document.querySelector('.git-commit-dialog');
      const dialogText = dialog?.textContent ?? '';
      return {
        rail: Boolean(rail),
        environment: Boolean(environment),
        changes: text.includes('Changes'),
        action: text.includes('Commit or push'),
        trigger: Boolean(document.querySelector('[aria-label="Environment and Git changes"]')),
        popup: Boolean(document.querySelector('.git-environment-popover')),
        dialog: dialog?.getAttribute('role') === 'dialog',
        generatedMessageHint: dialog?.querySelector('textarea')?.getAttribute('placeholder')?.includes('leave blank to generate') === true,
        includeUnstagedChanges: dialogText.includes('Include unstaged changes'),
        dialogActions: dialogText.includes('Commit and push') && dialogText.includes('Push'),
        manualRefresh: Boolean(environment?.querySelector('[aria-label="Refresh Git status"]')),
        counts: environment?.querySelector('.git-change-counts')?.textContent ?? ''
      };
    })()`) as typeof gitUI;
    if (gitUI.rail && gitUI.environment && gitUI.changes && gitUI.action && !gitUI.trigger && !gitUI.popup
      && gitUI.dialog && gitUI.generatedMessageHint && gitUI.includeUnstagedChanges && gitUI.dialogActions
      && !gitUI.manualRefresh) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!gitUI.rail || !gitUI.environment || !gitUI.changes || !gitUI.action || gitUI.trigger || gitUI.popup
    || !gitUI.dialog || !gitUI.generatedMessageHint || !gitUI.includeUnstagedChanges || !gitUI.dialogActions
    || gitUI.manualRefresh) {
    throw new Error(`packaged Git environment and commit dialog did not render correctly: ${JSON.stringify(gitUI)}`);
  }
  const expectedCounts = `+${String(gitStatus.additions)}-${String(gitStatus.deletions)}`;
  if (gitUI.counts.replaceAll(/\s/g, "") !== expectedCounts) {
    throw new Error(`packaged Git counts diverged from the runtime: ${JSON.stringify({ gitUI, expectedCounts })}`);
  }
  await mainWindow!.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const browserTabId = await runtime!.request("browser_ui_open_tab", { threadId, url: null }, 5_000) as string;
  // Human input interrupts the native engine through a sidecar host request.
  // A subsequent command proves that the sidecar input reader remains free to
  // receive that host response instead of deadlocking behind the event.
  runtime!.event("browser.human_input", { tabId: browserTabId });
  await runtime!.request("workspace_snapshot", {}, 5_000);
  const smokeAnnotationPreview = nativeImage.createFromDataURL(`data:image/png;base64,${SMOKE_ANNOTATION_PNG}`);
  if (smokeAnnotationPreview.isEmpty()) throw new Error("packaged annotation fixture PNG did not decode");
  const smokeAnnotationPreviewDataUrl = smokeAnnotationPreview.resize({ width: 96, height: 64, quality: "good" }).toDataURL();
  const turnId = await runtime!.request("send_prompt", {
    projectId,
    threadId,
    // Exercise the runtime's ownership guard through the packaged bridge: a
    // stale host selection must not forward a project that exists locally.
    hostId: "stale-remote-host",
    prompt: "Packaged runtime acceptance",
    imagePaths: [],
    attachmentIds: [],
    annotations: [{
      id: randomUUID(),
      tabId: randomUUID(),
      url: "https://example.com/",
      selector: "html > body > h1",
      tagName: "h1",
      role: "heading",
      name: "Example Domain",
      text: "Example Domain",
      instruction: "Make this heading orange",
      // Keep the packaged acceptance fixture visually decodable. Malformed
      // bytes labeled as PNG mask real preview regressions behind a broken icon.
      previewDataUrl: smokeAnnotationPreviewDataUrl,
      rect: { x: 10, y: 20, width: 100, height: 30 },
      createdAt: Date.now(),
    }],
  }, 5_000) as string;
  const persisted = await runtime!.request("workspace_snapshot", {}, 5_000) as Record<string, JsonValue>;
  const persistedProject = (persisted.projects as Array<Record<string, JsonValue>>).find((value) => value.id === projectId);
  const persistedThread = (persistedProject?.threads as Array<Record<string, JsonValue>> | undefined)?.find((value) => value.id === threadId);
  if (persistedThread?.provider !== "hermes" || persistedThread.model !== HERMES_SMOKE_MODEL) {
    throw new Error(`packaged runtime acceptance did not use local Qwen: ${JSON.stringify({ provider: persistedThread?.provider, model: persistedThread?.model })}`);
  }
  const messages = persistedThread?.messages as Array<Record<string, JsonValue>> | undefined;
  const annotationPersisted = messages?.some((message) => Array.isArray(message.annotations) && message.annotations.length === 1) === true;
  if (!turnId || !annotationPersisted) throw new Error("packaged runtime did not acknowledge and persist the annotated prompt");
  await runtime!.request("cancel_turn", { turnId }, 5_000);
  // A terminal PTY can make Electron's macOS stdin pipe briefly report EAGAIN.
  // Keep the packaged runtime alive across an idle boundary so verification
  // catches regressions in the real sidecar transport, not only request bursts.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await runtime!.request("workspace_snapshot", {}, 5_000);
  const projectless = await runtime!.request("add_chat", {
    provider: "codex",
    model: "default",
    title: "Projectless smoke chat",
    effort: null,
    speed: null,
  }, 5_000) as Record<string, JsonValue>;
  const projectlessThreadId = String(projectless.id ?? "");
  const projectlessReload = new Promise<void>((resolve) => mainWindow!.webContents.once("did-finish-load", () => resolve()));
  mainWindow!.webContents.reload();
  await projectlessReload;
  const projectlessDeadline = Date.now() + 10_000;
  let projectlessUI = { chats: false, row: false, collapsed: false, pinned: false, renamed: false, deleted: false };
  while (Date.now() < projectlessDeadline) {
    projectlessUI = await mainWindow!.webContents.executeJavaScript(`(() => ({
      chats: Array.from(document.querySelectorAll('.repositories-disclosure')).some((button) => button.textContent?.trim() === 'Chats'),
      row: Boolean(document.querySelector('[aria-label="Projectless smoke chat"]')),
      collapsed: false,
      pinned: false,
      renamed: false,
      deleted: false
    }))()`) as typeof projectlessUI;
    if (projectlessUI.chats && projectlessUI.row) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!projectlessUI.chats || !projectlessUI.row) {
    throw new Error(`projectless Chats section did not render: ${JSON.stringify(projectlessUI)}`);
  }
  await mainWindow!.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.repositories-disclosure'))
    .find((button) => button.textContent?.trim() === 'Chats')?.click()`);
  const collapseDeadline = Date.now() + 5_000;
  while (Date.now() < collapseDeadline) {
    projectlessUI.collapsed = await mainWindow!.webContents.executeJavaScript(`(() => {
      const disclosure = Array.from(document.querySelectorAll('.repositories-disclosure'))
        .find((button) => button.textContent?.trim() === 'Chats');
      return disclosure?.getAttribute('aria-expanded') === 'false'
        && document.querySelector('#sidebar-chats')?.getAttribute('aria-hidden') === 'true';
    })()`);
    if (projectlessUI.collapsed) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await mainWindow!.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.repositories-disclosure'))
    .find((button) => button.textContent?.trim() === 'Chats')?.click()`);
  const expandDeadline = Date.now() + 5_000;
  while (Date.now() < expandDeadline) {
    const expanded = await mainWindow!.webContents.executeJavaScript(`(() => {
      const disclosure = Array.from(document.querySelectorAll('.repositories-disclosure'))
        .find((button) => button.textContent?.trim() === 'Chats');
      return disclosure?.getAttribute('aria-expanded') === 'true'
        && document.querySelector('#sidebar-chats')?.getAttribute('aria-hidden') === 'false';
    })()`);
    if (expanded) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await mainWindow!.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Pin Projectless smoke chat"]')?.click()`,
  );
  const pinDeadline = Date.now() + 5_000;
  while (Date.now() < pinDeadline) {
    projectlessUI.pinned = await mainWindow!.webContents.executeJavaScript(
      `Boolean(document.querySelector('[aria-label="Unpin Projectless smoke chat"]'))`,
    );
    if (projectlessUI.pinned) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await mainWindow!.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[aria-label="Projectless smoke chat"]');
    row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await mainWindow!.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="Chat name"]');
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'Renamed projectless smoke chat');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form')?.requestSubmit();
    return true;
  })()`);
  const renameDeadline = Date.now() + 5_000;
  while (Date.now() < renameDeadline) {
    projectlessUI.renamed = await mainWindow!.webContents.executeJavaScript(
      `Boolean(document.querySelector('[aria-label="Renamed projectless smoke chat"]'))`,
    );
    if (projectlessUI.renamed) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await mainWindow!.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Delete Renamed projectless smoke chat"]')?.click()`,
  );
  const deleteDeadline = Date.now() + 5_000;
  while (Date.now() < deleteDeadline) {
    const afterDelete = await runtime!.request("workspace_snapshot", {}, 5_000) as Record<string, JsonValue>;
    const chats = (afterDelete.projects as Array<Record<string, JsonValue>>)
      .find((value) => value.id === "00000000-0000-0000-0000-000000000001");
    const threads = chats?.threads as Array<Record<string, JsonValue>> | undefined;
    projectlessUI.deleted = !threads?.some((value) => value.id === projectlessThreadId);
    if (projectlessUI.deleted) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!projectlessUI.collapsed || !projectlessUI.pinned || !projectlessUI.renamed || !projectlessUI.deleted) {
    throw new Error(`projectless chat behaviors failed: ${JSON.stringify(projectlessUI)}`);
  }
  process.stdout.write(`MAXX_APP_SMOKE ${JSON.stringify({ ok: true, ...state, voicePlayback, voiceSettingsUI, runtimeAck: true, runtimeProvider: "hermes", runtimeModel: HERMES_SMOKE_MODEL, annotationPersisted, isolatedWorkspace: true, automation: true, emptyChatUI, gitUI, projectlessUI })}\n`);
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
  const annotationEvents: JsonValue[] = [];
  const importer = new ChromeImporter(session.fromPartition("persist:maxx-browser", { cache: true }), app.getPath("userData"));
  const manager = new BrowserManager({
    window,
    userDataPath: app.getPath("userData"),
    emitRenderer: (event, payload) => {
      if (event === "browser://error") errors.push(payload);
      if (event === "browser://annotation") annotationEvents.push(payload);
    },
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
    stage = "rapid tab close";
    const transientTabId = randomUUID();
    const transientOpen = manager.execute(
      { ...context, tabId: transientTabId, actionId: randomUUID() },
      { operation: "open_tab", url: null },
    );
    manager.closeTab(transientTabId);
    await transientOpen;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const rapidCloseErrors = errors.filter((error) => (
      error && typeof error === "object" && !Array.isArray(error) && error.code === "browser.cdp-attach"
    ));
    if (rapidCloseErrors.length > 0) throw new Error(`closing a new tab surfaced a CDP setup error: ${JSON.stringify(rapidCloseErrors)}`);
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
    stage = "annotation selection";
    await manager.setAnnotationMode(tabId, true);
    await run({ operation: "click", tabId, reference: button.reference });
    for (const key of "update") await run({ operation: "press", tabId, key });
    await run({ operation: "press", tabId, key: "Enter" });
    for (let attempt = 0; attempt < 40 && annotationEvents.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const picked = annotationEvents.at(-1) as Record<string, JsonValue> | undefined;
    if (
      picked?.selected !== true ||
      picked.instruction !== "update" ||
      typeof picked.selector !== "string" ||
      typeof picked.previewDataUrl !== "string" ||
      !picked.previewDataUrl.startsWith("data:image/png;base64,")
    ) {
      throw new Error("Annotation mode did not emit the described element");
    }
    const selectedReference = await run({
      operation: "evaluate",
      tabId,
      expression: `(() => { const selected=document.querySelector(${JSON.stringify(picked.selector)}); const clicked=globalThis.__maxxBrowser?.refToElement.get(${JSON.stringify(button.reference)}); return selected === clicked; })()`,
    });
    if (selectedReference.value !== true) throw new Error("Annotation mode selected the wrong element");
    await manager.setAnnotationSelections(tabId, [
      { selector: picked.selector, index: 1, instruction: "update" },
      { selector: "#status", index: 2, instruction: "verify status" },
    ]);
    const hoveredInstruction = await run({
      operation: "evaluate",
      tabId,
      expression: `(() => { const element=document.querySelector(${JSON.stringify(picked.selector)}); if(!element)return "missing"; const rect=element.getBoundingClientRect(); dispatchEvent(new MouseEvent("mousemove",{clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,bubbles:true})); return globalThis.__maxxAnnotation?.hoveredInstruction ?? ""; })()`,
    });
    if (hoveredInstruction.value !== "update") throw new Error("Annotation marker hover did not reveal its instruction");
    const selectedBeforeReload = await run({ operation: "evaluate", tabId, expression: "globalThis.__maxxAnnotation?.selectionList?.length ?? 0" });
    if (selectedBeforeReload.value !== 2) throw new Error("Annotation overlay did not receive the composer selections");
    stage = "annotation reload persistence";
    await run({ operation: "reload", tabId });
    await run({ operation: "wait", tabId, condition: "globalThis.__maxxAnnotation?.selectionList?.length === 2", timeoutMs: 15_000 });
    const selectedAfterReload = await run({ operation: "evaluate", tabId, expression: "globalThis.__maxxAnnotation?.selectionList?.length ?? 0" });
    if (selectedAfterReload.value !== 2) throw new Error("Annotation overlay selections were lost on reload");
    await manager.setAnnotationMode(tabId, false);
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
    process.stdout.write(`MAXX_BROWSER_SMOKE ${JSON.stringify({ ok: true, tabId, observed, annotations: { emitted: annotationEvents.length, hoveredInstruction: hoveredInstruction.value, selectedBeforeReload: selectedBeforeReload.value, selectedAfterReload: selectedAfterReload.value }, screenshotBytes: bytes, persistedBefore, tabLifecycleRecovered, errors })}\n`);
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
      case "browser_annotation_selections":
        await browser?.setAnnotationSelections(String(params.tabId), params.selections as BrowserAnnotationSelection[]);
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
      case "clipboard_write_text":
        if (typeof params.text !== "string") throw new Error("Clipboard text must be a string");
        clipboard.writeText(params.text);
        return null;
      case "window_toggle_maximize":
        if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize();
        return null;
      case "set_shortcut_accelerators":
        installMenu(typeof params.toggleSidebar === "string" ? params.toggleSidebar : null, typeof params.toggleBrowser === "string" ? params.toggleBrowser : null);
        return null;
      case "check_for_updates":
        return await updater?.checkForUpdates(true) ?? {
          state: "unavailable",
          detail: "Updates are available in signed release builds.",
        };
      case "install_update":
        if (mainWindow) {
          const confirmation = await dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "Install Maxx Update",
            message: "Install the available Maxx update?",
            detail: "Maxx will download the signed update and relaunch when it is ready.",
            buttons: ["Later", "Install and Relaunch"],
            defaultId: 1,
            cancelId: 0,
            noLink: true,
          });
          if (confirmation.response === 0) return null;
        }
        return await updater?.downloadAndInstall() ?? {
          state: "failed",
          message: "The updater is not ready.",
        };
      case "restart_to_install_update":
        return updater?.restartToInstall() ?? {
          state: "failed",
          message: "The updater is not ready.",
        };
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
      let exitCode = 0;
      try {
        await initializeUpdater();
        await runAppSmoke();
      }
      catch (error) { process.stderr.write(`MAXX_APP_SMOKE_FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); exitCode = 1; }
      browser?.shutdown();
      browser = null;
      mainWindow?.destroy();
      mainWindow = null;
      const stoppingRuntime = runtime;
      stoppingRuntime?.shutdown();
      stoppingRuntime?.terminate();
      if (stoppingRuntime && !await stoppingRuntime.waitForExit()) {
        process.stderr.write("MAXX_APP_SMOKE_FAILED runtime did not exit after verification\n");
        exitCode = 1;
      }
      runtime = null;
      app.exit(exitCode);
      return;
    }
    if (browserSmoke) {
      let exitCode = 0;
      try { await runBrowserSmoke(); }
      catch (error) { process.stderr.write(`MAXX_BROWSER_SMOKE_FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); exitCode = 1; }
      app.exit(exitCode);
      return;
    }
    if (hermesBrowserSmoke) {
      let exitCode = 0;
      try { await runHermesBrowserSmoke(); }
      catch (error) { process.stderr.write(`MAXX_HERMES_BROWSER_SMOKE_FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); exitCode = 1; }
      app.exit(exitCode);
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
    if (terminalUiSmoke) {
      const project = await runtime!.request("add_project", { folderPath: terminalUiProject }, 5_000) as Record<string, JsonValue>;
      await runtime!.request("add_thread", {
        projectId: String(project.id),
        provider: "codex",
        model: "default",
        title: "Right panel terminal acceptance",
      }, 5_000);
      const reloaded = new Promise<void>((resolve) => mainWindow!.webContents.once("did-finish-load", () => resolve()));
      mainWindow!.webContents.reload();
      await reloaded;
    }
    await initializeUpdater();
    app.on("activate", () => { if (!mainWindow) void createWindow(); else mainWindow.show(); });
  }).catch((error) => { dialog.showErrorBox("Maxx could not start", String(error)); app.quit(); });
  app.on("before-quit", () => { quitting = true; browser?.shutdown(); runtime?.shutdown(); });
  app.on("quit", () => runtime?.terminate());
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
