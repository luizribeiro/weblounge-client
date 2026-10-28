{ pkgs }:

let
  account = "weblounge";
  password = "weblounge-test";
  botAccount = "weblounge-bot";
  botPassword = "weblounge-bot-test";
  apiToken = "weblounge-local-api-token";
  config = pkgs.runCommand "weblounge-ergo.yaml" { nativeBuildInputs = [ pkgs.yq-go ]; } ''
    ${pkgs.lib.getExe pkgs.ergochat} defaultconfig > "$out"
    yq --inplace '
      .network.name = "WebLoungeLocal" |
      .server.name = "irc.localhost" |
      .server.listeners = {
        "127.0.0.1:6667": null,
        "127.0.0.1:8067": {"websocket": true}
      } |
      .server.websockets.allowed-origins = [] |
      .server.motd = "" |
      .accounts.registration.enabled = false |
      .accounts.require-sasl.enabled = true |
      .accounts.require-sasl.exempted = [] |
      .accounts.login-throttling.enabled = false |
      .accounts.nick-reservation.force-nick-equals-account = false |
      .history.enabled = true |
      .history.persistent.enabled = false |
      .languages.enabled = false |
      .api.enabled = true |
      .api.listener = "127.0.0.1:8089" |
      .api.bearer-tokens = ["${apiToken}"]
    ' "$out"
  '';
in
pkgs.writeShellApplication {
  name = "weblounge-ergo";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.curl
    pkgs.ergochat
    pkgs.jq
  ];
  text = ''
    state_dir="$(mktemp -d -t weblounge-ergo.XXXXXXXX)"
    server_pid=""

    # The EXIT trap invokes this function indirectly.
    # shellcheck disable=SC2329
    cleanup() {
      set +e
      if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
        kill "$server_pid"
        wait "$server_pid"
      fi
      rm -rf -- "$state_dir"
    }
    trap cleanup EXIT
    trap 'exit 130' INT TERM HUP

    cd "$state_dir"
    ergo run --conf ${config} &
    server_pid="$!"

    account_created=false
    bot_created=false
    for _ in $(seq 1 100); do
      if ! kill -0 "$server_pid" 2>/dev/null; then
        echo "Ergo exited before its test account was created" >&2
        exit 1
      fi

      if [[ "$account_created" != true ]]; then
        account_response="$(curl --silent --show-error \
          --header 'Authorization: Bearer ${apiToken}' \
          --header 'Content-Type: application/json' \
          --data '{"accountName":"${account}","passphrase":"${password}"}' \
          http://127.0.0.1:8089/v1/saregister 2>/dev/null || true)"
        if jq --exit-status '.success == true' <<<"$account_response" >/dev/null 2>&1; then
          account_created=true
        fi
      fi
      if [[ "$bot_created" != true ]]; then
        bot_response="$(curl --silent --show-error \
          --header 'Authorization: Bearer ${apiToken}' \
          --header 'Content-Type: application/json' \
          --data '{"accountName":"${botAccount}","passphrase":"${botPassword}"}' \
          http://127.0.0.1:8089/v1/saregister 2>/dev/null || true)"
        if jq --exit-status '.success == true' <<<"$bot_response" >/dev/null 2>&1; then
          bot_created=true
        fi
      fi
      if [[ "$account_created" == true && "$bot_created" == true ]]; then
        break
      fi
      sleep 0.05
    done

    if [[ "$account_created" != true || "$bot_created" != true ]]; then
      echo "Could not create the local Ergo test accounts" >&2
      exit 1
    fi

    printf '\nWebLounge local Ergo is ready\n'
    printf '  IRC:      irc://127.0.0.1:6667\n'
    printf '  WebSocket: ws://127.0.0.1:8067\n'
    printf '  SASL user: %s\n' '${account}'
    printf '  password:  %s\n\n' '${password}'
    printf '  bot user:  %s\n' '${botAccount}'
    printf '  password:  %s\n\n' '${botPassword}'

    wait "$server_pid"
    status="$?"
    server_pid=""
    exit "$status"
  '';
}
