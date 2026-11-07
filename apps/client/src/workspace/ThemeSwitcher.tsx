import { useEffect, useState, type JSX } from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "audivane.theme";
const PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isPreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

function resolve(preference: ThemePreference): "light" | "dark" {
  return preference === "system"
    ? systemPrefersDark() ? "dark" : "light"
    : preference;
}

/**
 * Apply the resolved theme before React paints. The attribute is the single
 * source of truth for both token sets and native control colour schemes.
 */
function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  root.dataset.theme = resolve(preference);
  root.dataset.themePreference = preference;
}

const initialPreference = typeof window === "undefined" ? "system" : readPreference();
if (typeof document !== "undefined") applyTheme(initialPreference);

/**
 * System is the default and keeps following the OS while selected. Light and
 * Dark are explicit local preferences. Nothing here touches zoom or audio.
 */
export function useThemePreference(): {
  readonly preference: ThemePreference;
  readonly setPreference: (next: ThemePreference) => void;
} {
  const [preference, setPreference] = useState<ThemePreference>(initialPreference);
  const [systemDark, setSystemDark] = useState<boolean>(
    typeof window === "undefined" ? false : systemPrefersDark(),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    let media: MediaQueryList;
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    setSystemDark(media.matches);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    // Older WebViews expose the deprecated listener API only.
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const resolved = preference === "system"
      ? systemDark ? "dark" : "light"
      : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    try {
      window.localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Storage may be unavailable in a private or locked-down context.
    }
  }, [preference, systemDark]);

  return { preference, setPreference };
}

export function ThemeSwitcher(props: {
  readonly preference: ThemePreference;
  readonly onChange: (next: ThemePreference) => void;
}): JSX.Element {
  return (
    <label className="theme-control">
      <span className="theme-label">Theme</span>
      <select
        aria-label="Theme"
        value={props.preference}
        onChange={(event) => {
          const next = event.target.value;
          if (isPreference(next)) props.onChange(next);
        }}
      >
        {PREFERENCES.map((value) => (
          <option key={value} value={value}>
            {value === "system" ? "System" : value === "light" ? "Light" : "Dark"}
          </option>
        ))}
      </select>
    </label>
  );
}
