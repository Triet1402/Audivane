/// <reference types="vite/client" />

import type { DesktopBridge } from "@codec-abx/contracts";

declare global {
  interface Window {
    /** Present only in the Electron build; plain web never exposes this. */
    readonly codecAbxDesktop?: DesktopBridge;
  }
}
