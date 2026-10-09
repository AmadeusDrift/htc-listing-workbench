declare const __HTC_TEST_FIXTURES__: boolean;
declare const __HTC_NATIVE_HOST__: string;
declare const chrome: {
  runtime: {
    id: string; lastError?: { message?: string };
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    sendNativeMessage(host: string, message: unknown, callback: (reply: unknown) => void): void;
    onMessage: { addListener(listener: (message: unknown, sender: { id?: string; url?: string }, respond: (response: unknown) => void) => boolean | void): void };
  };
  tabs: { query(query: { active: boolean; lastFocusedWindow: boolean }): Promise<{ id?: number; url?: string }[]> };
  scripting: { executeScript(options: { target: { tabId: number }; world: 'MAIN'; func: typeof import('./read-page').read1688Page; args: [boolean] }): Promise<{ result?: unknown }[]> };
};
