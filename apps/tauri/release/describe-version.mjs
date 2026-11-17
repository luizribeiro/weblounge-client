// The server's client pins carry this version beside the commit, because a flake input has no tags
// to compute it from (design 37). Run it from a checkout of weblounge-client.
import { commitVersionOf, fetchMainAndTags } from "./shell.mjs";

const commit = process.argv[2];
if (commit === undefined) {
  console.error("usage: node apps/tauri/release/describe-version.mjs <commit>");
  process.exit(1);
}
fetchMainAndTags();
console.log(commitVersionOf(commit).display);
