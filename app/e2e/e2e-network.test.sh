set -euo pipefail

network_script=$1
test_dir=$(mktemp -d)
trap 'rm -rf -- "$test_dir"' EXIT

printf '#!%s\nexit 0\n' "$BASH" >"$test_dir/no-default-route"
printf '#!%s\n: >"$WEBLOUNGE_E2E_DENIAL_MARKER"\nexit 1\n' "$BASH" \
  >"$test_dir/deny-unshare"
chmod +x "$test_dir/no-default-route" "$test_dir/deny-unshare"

export WEBLOUNGE_E2E_DENIAL_MARKER="$test_dir/unshare-attempted"
export WEBLOUNGE_E2E_IP_COMMAND="$test_dir/no-default-route"
export WEBLOUNGE_E2E_UNSHARE_COMMAND="$test_dir/deny-unshare"

output=$(bash "$network_script" /unused-runner printf 'fallback ran')

[[ -e "$WEBLOUNGE_E2E_DENIAL_MARKER" ]]
[[ "$output" == "fallback ran" ]]
