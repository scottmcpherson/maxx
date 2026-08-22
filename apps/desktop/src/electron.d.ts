interface MaxxDesktopBridge {
  invoke<T>(method: string, params?: unknown): Promise<T>;
  listen<T>(event: string, callback: (payload: T) => void): () => void;
  mediaURL(filePath: string): string;
  filePath(file: File): string;
}

declare global {
  interface Window {
    maxx: MaxxDesktopBridge;
  }
}

export {};
