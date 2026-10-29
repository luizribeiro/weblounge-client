{ pkgs }:

let
  account = "weblounge";
  password = "weblounge-test";
  botAccount = "weblounge-bot";
  botPassword = "weblounge-bot-test";
  apiToken = "weblounge-local-api-token";
  allowedOrigin = "http://127.0.0.1:4173";
  config =
    pkgs.runCommand "weblounge-ergo-production-profile.yaml" { nativeBuildInputs = [ pkgs.yq-go ]; }
      ''
        ${pkgs.lib.getExe pkgs.ergochat} defaultconfig > "$out"
        yq --inplace '
          .network.name = "weblounge" |
          .server.name = "irc.localhost" |
          .server.listeners = {
            "127.0.0.1:6668": null,
            "127.0.0.1:8069": {"websocket": true}
          } |
          .server.websockets.allowed-origins = ["${allowedOrigin}"] |
          .server.motd = "" |
          .server.ip-cloaking.netname = "weblounge" |
          .server.ip-cloaking.num-bits = 0 |
          .accounts.registration.enabled = false |
          .accounts.require-sasl.enabled = true |
          .accounts.require-sasl.exempted = [] |
          .accounts.multiclient.always-on = "opt-out" |
          .accounts.multiclient.auto-away = "opt-out" |
          .accounts.disabled-service-commands.nickserv = ["unregister", "passwd"] |
          .accounts.disabled-service-commands.hostserv = ["on", "off"] |
          .accounts.login-throttling.enabled = false |
          .accounts.nick-reservation.force-nick-equals-account = false |
          .channels.auto-join = ["#lounge"] |
          .history.enabled = true |
          .history.persistent.enabled = true |
          .history.persistent.unregistered-channels = true |
          .history.persistent.direct-messages = "opt-out" |
          .history.restrictions.expire-time = "2w" |
          .history.retention.allow-individual-delete = true |
          .datastore.sqlite.enabled = true |
          .webpush.enabled = true |
          .webpush.subscriber = "https://weblounge.local" |
          .languages.enabled = false |
          .api.enabled = true |
          .api.listener = "127.0.0.1:18088" |
          .api.bearer-tokens = ["${apiToken}"]
        ' "$out"
      '';
  nginxConfig = pkgs.writeText "weblounge-ergo-nginx.conf" ''
    daemon off;
    error_log stderr notice;
    pid @STATE_DIR@/nginx.pid;

    events {}

    http {
      access_log off;

      map $http_upgrade $connection_upgrade {
        default upgrade;
        "" close;
      }

      server {
        listen 127.0.0.1:8068 ssl;
        ssl_certificate @STATE_DIR@/tls/server.pem;
        ssl_certificate_key @STATE_DIR@/tls/server-key.pem;
        ssl_protocols TLSv1.2 TLSv1.3;

        location / {
          proxy_pass http://127.0.0.1:8069;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection $connection_upgrade;
          proxy_set_header X-Forwarded-For $remote_addr;
        }
      }
    }
  '';
in
pkgs.writeShellApplication {
  name = "weblounge-ergo-weblounge";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.curl
    pkgs.ergochat
    pkgs.gnused
    pkgs.jq
    pkgs.nginx
    pkgs.openssl
  ];
  text = ''
    owned_state=false
    if [[ -n "''${WEBLOUNGE_ERGO_STATE_DIR:-}" ]]; then
      state_dir="$WEBLOUNGE_ERGO_STATE_DIR"
      mkdir -p "$state_dir"
    else
      state_dir="$(mktemp -d -t weblounge-ergo-production.XXXXXXXX)"
      owned_state=true
    fi
    state_dir="$(realpath "$state_dir")"
    ergo_pid=""
    nginx_pid=""

    # The EXIT trap invokes this function indirectly.
    # shellcheck disable=SC2329
    cleanup() {
      set +e
      for pid in "$nginx_pid" "$ergo_pid"; do
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
          kill "$pid"
          wait "$pid"
        fi
      done
      if [[ "$owned_state" == true ]]; then
        rm -rf -- "$state_dir"
      fi
    }
    trap cleanup EXIT
    trap 'exit 130' INT TERM HUP

    mkdir -p "$state_dir/tls"
    if [[ ! -f "$state_dir/tls/ca.pem" ]]; then
      openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
        -subj '/CN=WebLounge local test CA' \
        -keyout "$state_dir/tls/ca-key.pem" \
        -out "$state_dir/tls/ca.pem" >/dev/null 2>&1
      openssl req -newkey rsa:2048 -nodes \
        -subj '/CN=127.0.0.1' \
        -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
        -keyout "$state_dir/tls/server-key.pem" \
        -out "$state_dir/tls/server.csr" >/dev/null 2>&1
      printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n' \
        > "$state_dir/tls/server.ext"
      openssl x509 -req -days 2 \
        -in "$state_dir/tls/server.csr" \
        -CA "$state_dir/tls/ca.pem" \
        -CAkey "$state_dir/tls/ca-key.pem" \
        -CAcreateserial \
        -extfile "$state_dir/tls/server.ext" \
        -out "$state_dir/tls/server.pem" >/dev/null 2>&1
    fi

    cd "$state_dir"
    ergo run --conf ${config} &
    ergo_pid="$!"

    if [[ ! -f "$state_dir/.accounts-created" ]]; then
      account_created=false
      bot_created=false
      for _ in $(seq 1 200); do
        if ! kill -0 "$ergo_pid" 2>/dev/null; then
          echo "Ergo exited before its test accounts were created" >&2
          exit 1
        fi
        if [[ "$account_created" != true ]]; then
          response="$(curl --silent --show-error \
            --header 'Authorization: Bearer ${apiToken}' \
            --header 'Content-Type: application/json' \
            --data '{"accountName":"${account}","passphrase":"${password}"}' \
            http://127.0.0.1:18088/v1/saregister 2>/dev/null || true)"
          if jq --exit-status '.success == true' <<<"$response" >/dev/null 2>&1; then
            account_created=true
          fi
        fi
        if [[ "$bot_created" != true ]]; then
          response="$(curl --silent --show-error \
            --header 'Authorization: Bearer ${apiToken}' \
            --header 'Content-Type: application/json' \
            --data '{"accountName":"${botAccount}","passphrase":"${botPassword}"}' \
            http://127.0.0.1:18088/v1/saregister 2>/dev/null || true)"
          if jq --exit-status '.success == true' <<<"$response" >/dev/null 2>&1; then
            bot_created=true
          fi
        fi
        if [[ "$account_created" == true && "$bot_created" == true ]]; then
          touch "$state_dir/.accounts-created"
          break
        fi
        sleep 0.05
      done
      if [[ ! -f "$state_dir/.accounts-created" ]]; then
        echo "Could not create the local Ergo test accounts" >&2
        exit 1
      fi
    fi

    sed "s|@STATE_DIR@|$state_dir|g" ${nginxConfig} > "$state_dir/nginx.conf"
    nginx -e stderr -p "$state_dir" -c "$state_dir/nginx.conf" &
    nginx_pid="$!"
    ready=false
    for _ in $(seq 1 200); do
      if ! kill -0 "$ergo_pid" 2>/dev/null || ! kill -0 "$nginx_pid" 2>/dev/null; then
        echo "Ergo or nginx exited before the secure WebSocket listener was ready" >&2
        exit 1
      fi
      if curl --silent --insecure --max-time 1 \
        https://127.0.0.1:8068/ >/dev/null 2>&1; then
        ready=true
        break
      fi
      sleep 0.05
    done
    if [[ "$ready" != true ]]; then
      echo "The secure WebSocket listener did not become ready" >&2
      exit 1
    fi

    printf '\nWebLounge production-profile Ergo is ready\n'
    printf '  IRC:        irc://127.0.0.1:6668\n'
    printf '  WebSocket:  wss://127.0.0.1:8068\n'
    printf '  origin:     %s\n' '${allowedOrigin}'
    printf '  test CA:    %s\n' "$state_dir/tls/ca.pem"
    printf '  state:      %s\n' "$state_dir"
    printf '  SASL user:  %s\n' '${account}'
    printf '  password:   %s\n' '${password}'
    printf '  bot user:   %s\n' '${botAccount}'
    printf '  password:   %s\n\n' '${botPassword}'

    set +e
    wait -n "$ergo_pid" "$nginx_pid"
    status="$?"
    set -e
    exit "$status"
  '';
}
