set -euo pipefail

runner=$1
shift

ip_command=${WEBLOUNGE_E2E_IP_COMMAND:-ip}
unshare_command=${WEBLOUNGE_E2E_UNSHARE_COMMAND:-unshare}

if [[ -n "$("$ip_command" route show default)" ]]; then
  exec "$@"
fi

if "$unshare_command" --user --map-root-user --net true >/dev/null 2>&1; then
  exec "$unshare_command" --user --map-root-user --net "$runner" "$@"
fi

echo "E2E network namespace unavailable; using the current network" >&2
exec "$@"
