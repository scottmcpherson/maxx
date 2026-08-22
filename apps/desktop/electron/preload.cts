import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("maxx", {
  invoke: (method: string, params: unknown = {}) => ipcRenderer.invoke("maxx:invoke", method, params),
  listen: (event: string, callback: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload);
    ipcRenderer.on(`maxx:event:${event}`, handler);
    return () => ipcRenderer.removeListener(`maxx:event:${event}`, handler);
  },
  mediaURL: (filePath: string) => `maxx-media://file/${Buffer.from(filePath, "utf8").toString("base64url")}`,
});
