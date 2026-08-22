import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("maxx", {
  invoke: (method: string, params: unknown = {}) => ipcRenderer.invoke("maxx:invoke", method, params),
  listen: (event: string, callback: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload);
    ipcRenderer.on(`maxx:event:${event}`, handler);
    return () => ipcRenderer.removeListener(`maxx:event:${event}`, handler);
  },
  mediaURL: (filePath: string) => {
    const encoded = Buffer.from(filePath, "utf8").toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    return `maxx-media://file/${encoded}`;
  },
  filePath: (file: File) => webUtils.getPathForFile(file),
});
