/**
 * Which app this desktop build is. The default build is T3 Code; a build made
 * with T3CODE_DESKTOP_VARIANT=mcode is M Code, an experimental side-by-side
 * app. Everything that would let two installs see each other's state is keyed
 * here: the data directory, Electron's profile directory (which also scopes
 * the single-instance lock), the window class and desktop entry, and whether
 * the app claims the t3code:// URL scheme.
 */
declare const __T3CODE_DESKTOP_VARIANT__: string | undefined;

export interface DesktopVariant {
  readonly id: "t3code" | "mcode";
  readonly baseName: string;
  /** Directory under the home directory that holds server and desktop state. */
  readonly homeDirName: string;
  /** Environment variable that overrides the data directory. */
  readonly homeEnvVar: string;
  /** Electron profile directory, window class, and app id stem. */
  readonly slug: string;
  readonly appUserModelId: string;
  readonly linuxDesktopEntryStem: string;
  /** Only the real app registers as the t3code:// handler. */
  readonly ownsUrlScheme: boolean;
}

const T3CODE: DesktopVariant = {
  id: "t3code",
  baseName: "T3 Code",
  homeDirName: ".t3",
  homeEnvVar: "T3CODE_HOME",
  slug: "t3code",
  appUserModelId: "com.t3tools.t3code",
  linuxDesktopEntryStem: "com.t3tools.T3Code",
  ownsUrlScheme: true,
};

const MCODE: DesktopVariant = {
  id: "mcode",
  baseName: "M Code",
  homeDirName: ".mcode",
  homeEnvVar: "MCODE_HOME",
  slug: "mcode",
  appUserModelId: "dev.mcode.mcode",
  linuxDesktopEntryStem: "dev.mcode.MCode",
  ownsUrlScheme: false,
};

export const DESKTOP_VARIANT: DesktopVariant =
  typeof __T3CODE_DESKTOP_VARIANT__ === "string" && __T3CODE_DESKTOP_VARIANT__ === "mcode"
    ? MCODE
    : T3CODE;
