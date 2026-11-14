import {
  applyAppearanceHint,
  readAppearanceHint,
} from "../theme/appearance-hint";
import { darkSchemeQuery } from "./color-scheme";

applyAppearanceHint(
  document.documentElement,
  readAppearanceHint(() => localStorage),
  matchMedia(darkSchemeQuery).matches,
);
