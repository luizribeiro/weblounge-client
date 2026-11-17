import { platformEnvironment } from "../../platform/environment";

export const inBrowserTab = () =>
  platformEnvironment().environment().display === "browser";
