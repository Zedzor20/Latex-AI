/// <reference types="vite/client" />
import type { LatexApi } from "../../preload/preload";

declare global {
  interface Window {
    latex: LatexApi;
  }
}
