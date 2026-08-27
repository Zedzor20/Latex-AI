import type { ThemePreference } from "../../../shared/types";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(pref: ThemePreference): "dark" | "light" {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

export function applyTheme(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(pref);
}

/** Subscribe to OS theme changes; only meaningful when the preference is "system". */
export function watchSystemTheme(callback: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}
