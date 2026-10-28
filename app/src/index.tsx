import { render } from "solid-js/web";
import { App } from "./App";
import "./styles/base.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("missing application root");
}

render(() => <App />, root);
