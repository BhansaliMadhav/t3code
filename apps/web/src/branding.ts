import type { DesktopAppBranding } from "@t3tools/contracts";
import { formatAppDisplayName } from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding?.() ?? null;
}

// Rebranded builds rewrite this tag in index.html, so browsers served by such
// a server show its name even without the desktop bridge.
function readDocumentAppName(): string | null {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") {
    return null;
  }

  return (
    document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content.trim() || null
  );
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL =
  HOSTED_APP_CHANNEL === "nightly" ? "Nightly" : HOSTED_APP_CHANNEL === "latest" ? "Latest" : null;
const T3_CODE_BASE_NAME = "T3 Code";
export const APP_BASE_NAME =
  injectedDesktopAppBranding?.baseName ?? readDocumentAppName() ?? T3_CODE_BASE_NAME;
/** Builds named something else, such as the M Code desktop variant, show their name as text. */
export const APP_HAS_T3_WORDMARK = APP_BASE_NAME === T3_CODE_BASE_NAME;
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ??
  HOSTED_APP_CHANNEL_LABEL ??
  (import.meta.env.DEV ? "Dev" : "Alpha");
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
