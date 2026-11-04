{
  checkApp,
  papo-test-infra,
  pkgs,
  previousApp,
  pushE2eHarness,
  pushRelayE2e,
}:

let
  addresses = {
    ergo = "203.0.113.1";
    relay = "203.0.113.2";
    receiver = "203.0.113.3";
    app = "203.0.113.4";
  };
  ergoProduction = pkgs.callPackage "${papo-test-infra}/nix/ergochat.nix" { };
  ergoE2e = ergoProduction.overrideAttrs (previous: {
    patches = previous.patches ++ [
      (pkgs.fetchpatch {
        url = "https://github.com/ergochat/ergo/commit/9975d8dc0bff2f51e79b7307b9955da375a945fe.patch";
        hash = "sha256-fLQisMdGqdD5CBlxhlN5sD2iMTWWlOhWl+rUkRU19Ec=";
      })
    ];
  });
  pki = pkgs.runCommand "weblounge-push-e2e-pki" { nativeBuildInputs = [ pkgs.openssl ]; } ''
    mkdir -p $out
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
      -subj /CN=weblounge-push-e2e-ca \
      -keyout $out/ca.key -out $out/ca.crt

    issue_certificate() {
      name="$1"
      host="$2"
      subject_alt_name="''${3:-DNS:$host}"
      openssl req -newkey rsa:2048 -nodes -subj "/CN=$host" \
        -addext "subjectAltName=$subject_alt_name" \
        -keyout "$out/$name.key" -out "$out/$name.csr"
      openssl x509 -req -days 2 -in "$out/$name.csr" \
        -CA $out/ca.crt -CAkey $out/ca.key -CAcreateserial \
        -copy_extensions copy -out "$out/$name.crt"
    }
    issue_certificate app app.test
    issue_certificate relay push.test
    issue_certificate receiver web.push.apple.com \
      DNS:web.push.apple.com,DNS:updates.push.services.mozilla.com

    openssl ecparam -name prime256v1 -genkey -noout -out $out/relay-vapid.pem
    openssl ec -in $out/relay-vapid.pem -pubout -outform DER 2>/dev/null \
      | tail -c 65 | base64 -w0 | tr '+/' '-_' | tr -d '=' \
      > $out/relay-vapid-public
  '';
  appConfig = pkgs.runCommand "weblounge-push-e2e-config.json" { nativeBuildInputs = [ pkgs.jq ]; } ''
    jq --null-input --compact-output \
      --arg relay_vapid "$(cat ${pki}/relay-vapid-public)" \
      '{
        mode: "hosted",
        network: {
          name: "weblounge",
          endpoint: "wss://app.test/socket",
          autojoin: ["#push-e2e"]
        },
        oauth: {
          issuer: "https://app.test",
          client_id: "weblounge-client",
          redirect_uri: "https://app.test/",
          session_token_endpoint: "https://app.test/oauth/session-token"
        },
        push: {
          relay: "https://push.test",
          relay_vapid: $relay_vapid
        }
      }' > $out
  '';
  vlan = address: {
    virtualisation.vlans = [ 1 ];
    networking.interfaces.eth1.ipv4.addresses = [
      {
        inherit address;
        prefixLength = 24;
      }
    ];
  };
  hosts = ''
    ${addresses.ergo} ergo.test
    ${addresses.relay} push.test
    ${addresses.receiver} web.push.apple.com receiver.test
    ${addresses.receiver} updates.push.services.mozilla.com
    ${addresses.app} app.test
  '';
  nginxTls = certificate: key: ''
    ssl_certificate ${certificate};
    ssl_certificate_key ${key};
    ssl_protocols TLSv1.2 TLSv1.3;
  '';
  pushDriverWorker = pkgs.writeText "weblounge-push-driver-worker.js" ''
    const nativeAddEventListener = globalThis.addEventListener.bind(globalThis);
    const visibleNotifications = [];
    const persistNotifications = async () => {
      const cache = await caches.open("push-e2e-driver");
      await cache.put(
        "/push-driver-notifications",
        new Response(JSON.stringify(visibleNotifications.map((notification) => ({
          title: notification.title,
          body: notification.body,
          tag: notification.tag,
        })))),
      );
    };
    Object.defineProperties(globalThis.registration, {
      getNotifications: {
        value: async ({ tag } = {}) => visibleNotifications.filter(
          (notification) => tag === undefined || notification.tag === tag,
        ),
      },
      showNotification: {
        value: async (title, options = {}) => {
          if (options.tag) {
            const previous = visibleNotifications.findIndex(
              (notification) => notification.tag === options.tag,
            );
            if (previous !== -1) visibleNotifications.splice(previous, 1);
          }
          const notification = {
            title,
            body: options.body ?? "",
            tag: options.tag ?? "",
            close: () => {
              const index = visibleNotifications.indexOf(notification);
              if (index !== -1) visibleNotifications.splice(index, 1);
              void persistNotifications();
            },
          };
          visibleNotifications.push(notification);
          await persistNotifications();
        },
      },
    });
    let pushHandler;
    globalThis.addEventListener = (type, listener, options) => {
      if (type === "push") {
        pushHandler = listener;
        return;
      }
      nativeAddEventListener(type, listener, options);
    };
    importScripts("/service-worker.js");
    nativeAddEventListener("message", (event) => {
      let completion;
      if (event.data?.type === "clear-notifications") {
        visibleNotifications.splice(0);
        completion = persistNotifications();
      } else if (event.data?.type === "deliver-push") {
        try {
          if (typeof pushHandler !== "function") {
            throw new Error("production push handler is missing");
          }
          pushHandler({
            data: { json: () => JSON.parse(event.data.payload) },
            waitUntil: (promise) => { completion = promise; },
          });
        } catch (error) {
          completion = Promise.reject(error);
        }
      } else return;
      const result = Promise.resolve(completion).then(
        () => ({ ok: true }),
        (error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      ).then(async (status) => {
        const cache = await caches.open("push-e2e-driver");
        await cache.put(
          `/push-driver-result/''${event.data.deliveryId}`,
          new Response(JSON.stringify(status)),
        );
      });
      event.waitUntil(result);
    });
  '';
in
pkgs.testers.runNixOSTest {
  name = "weblounge-push-e2e";

  nodes = {
    ergo =
      { lib, ... }:
      lib.mkMerge [
        (vlan addresses.ergo)
        {
          networking.extraHosts = hosts;
          networking.firewall.allowedTCPPorts = [
            6667
            8067
            8089
          ];
          security.pki.certificateFiles = [ "${pki}/ca.crt" ];
          services.ergochat = {
            enable = true;
            settings = {
              network.name = "weblounge-push-e2e";
              server = {
                casemapping = "ascii";
                enforce-utf8 = true;
                name = "ergo.test";
                listeners = {
                  ":6667" = { };
                  ":8067".websocket = true;
                };
                websockets.allowed-origins = [ "https://app.test" ];
                motd = "";
              };
              accounts = {
                registration.enabled = false;
                login-throttling.enabled = false;
                nick-reservation.force-nick-equals-account = false;
                multiclient = {
                  enabled = true;
                  allowed-by-default = true;
                  always-on = "opt-out";
                  auto-away = "opt-out";
                };
                oauth2 = {
                  enabled = true;
                  autocreate = true;
                  introspection-url = "http://${addresses.app}:8080/introspect";
                  client-id = "";
                  client-secret = "";
                  introspection-timeout = "10s";
                };
              };
              channels.auto-join = [ "#push-e2e" ];
              history.enabled = true;
              limits.multiline = {
                max-bytes = 4096;
                max-lines = 100;
              };
              webpush = {
                enabled = true;
                timeout = "5s";
                delay = "0s";
                subscriber = "https://app.test/";
                max-subscriptions = 10;
              };
              languages.enabled = false;
              api = {
                enabled = true;
                listener = ":8089";
                bearer-tokens = [ "weblounge-push-e2e-api" ];
              };
            };
          };
          systemd.services.ergochat.serviceConfig.ExecStart =
            lib.mkForce "${lib.getExe ergoE2e} run --conf /etc/ergo.yaml";
        }
      ];

    relay =
      { lib, ... }:
      lib.mkMerge [
        (vlan addresses.relay)
        {
          networking.extraHosts = hosts;
          networking.firewall.allowedTCPPorts = [
            443
            8098
          ];
          systemd.services.weblounge-push-relay = {
            wantedBy = [ "multi-user.target" ];
            after = [ "network-online.target" ];
            wants = [ "network-online.target" ];
            serviceConfig = {
              DynamicUser = true;
              StateDirectory = "weblounge-push-relay";
              ExecStart = lib.escapeShellArgs [
                "${pushRelayE2e}/bin/weblounge-push-relay"
                "--listen"
                "0.0.0.0:8098"
                "--state-dir"
                "/var/lib/weblounge-push-relay"
                "--origin"
                "https://push.test"
                "--allowed-origins"
                "https://app.test"
                "--vapid-key-file"
                "${pki}/relay-vapid.pem"
                "--concierge-url"
                "http://${addresses.app}:8080/introspect"
                "--concierge-secret-file"
                "${pkgs.writeText "push-e2e-concierge-secret" "test-secret"}"
                "--test-target-host"
                "web.push.apple.com"
                "--test-target-host"
                "updates.push.services.mozilla.com"
                "--test-ca-file"
                "${pki}/ca.crt"
              ];
            };
          };
          services.nginx = {
            enable = true;
            virtualHosts."push.test" = {
              listen = [
                {
                  addr = "0.0.0.0";
                  port = 443;
                  ssl = true;
                }
              ];
              extraConfig = nginxTls "${pki}/relay.crt" "${pki}/relay.key";
              locations."/" = {
                proxyPass = "http://127.0.0.1:8098";
                extraConfig = "proxy_set_header Host $host;";
              };
            };
          };
        }
      ];

    receiver =
      { lib, ... }:
      {
        imports = [ "${papo-test-infra}/nix/webpush-receiver.nix" ];
        config = lib.mkMerge [
          (vlan addresses.receiver)
          {
            networking.extraHosts = hosts;
            networking.firewall.allowedTCPPorts = [
              443
              8080
            ];
            services.webpush-receiver = {
              enable = true;
              listenAddress = addresses.receiver;
              port = 443;
              certificateFile = "${pki}/receiver.crt";
              keyFile = "${pki}/receiver.key";
            };
            users.users.webpush-receiver = {
              isSystemUser = true;
              group = "webpush-receiver";
            };
            users.groups.webpush-receiver = { };
            systemd.services.webpush-receiver.serviceConfig = {
              AmbientCapabilities = [ "CAP_NET_BIND_SERVICE" ];
              CapabilityBoundingSet = [ "CAP_NET_BIND_SERVICE" ];
              DynamicUser = lib.mkForce false;
              User = "webpush-receiver";
              Group = "webpush-receiver";
              StateDirectoryMode = "0755";
            };
            services.nginx = {
              enable = true;
              virtualHosts."receiver-records" = {
                listen = [
                  {
                    addr = "0.0.0.0";
                    port = 8080;
                  }
                ];
                root = "/var/lib/webpush-receiver";
              };
            };
          }
        ];
      };

    app =
      { lib, ... }:
      lib.mkMerge [
        (vlan addresses.app)
        {
          networking.extraHosts = hosts;
          networking.firewall.allowedTCPPorts = [
            443
            8080
          ];
          security.pki.certificateFiles = [ "${pki}/ca.crt" ];
          systemd.tmpfiles.rules = [
            "d /var/lib/weblounge-push-app 0755 root root -"
            "L+ /var/lib/weblounge-push-app/current - - - - ${previousApp}"
          ];
          services.nginx = {
            enable = true;
            appendHttpConfig = ''
              map $http_upgrade $push_connection_upgrade {
                default upgrade;
                "" close;
              }
            '';
            virtualHosts = {
              "app.test" = {
                listen = [
                  {
                    addr = "0.0.0.0";
                    port = 443;
                    ssl = true;
                  }
                ];
                root = "/var/lib/weblounge-push-app/current";
                extraConfig = nginxTls "${pki}/app.crt" "${pki}/app.key";
                locations = {
                  "= /config.json" = {
                    alias = appConfig;
                    extraConfig = "default_type application/json;";
                  };
                  "= /oauth/session-token".extraConfig = ''
                    default_type application/json;
                    return 200 '{"access_token":"push-e2e-token","token_type":"Bearer","expires_in":900}';
                  '';
                  "/socket" = {
                    proxyPass = "http://${addresses.ergo}:8067";
                    extraConfig = ''
                      proxy_http_version 1.1;
                      proxy_set_header Upgrade $http_upgrade;
                      proxy_set_header Connection $push_connection_upgrade;
                      proxy_set_header Origin https://app.test;
                    '';
                  };
                  "= /push-driver.html".extraConfig = ''
                    default_type text/html;
                    return 200 '<!doctype html><title>Push driver</title>';
                  '';
                  "= /push-driver-sw.js" = {
                    alias = pushDriverWorker;
                    extraConfig = "default_type application/javascript;";
                  };
                  "/".extraConfig = "try_files $uri $uri/ /index.html;";
                };
              };
              "concierge" = {
                listen = [
                  {
                    addr = "0.0.0.0";
                    port = 8080;
                  }
                ];
                locations."/introspect".extraConfig = ''
                  default_type application/json;
                  return 200 '{"active":true,"username":"weblounge"}';
                '';
              };
            };
          };
          environment.systemPackages = [
            pkgs.chromium
            pkgs.nodejs
            pkgs.pnpm
          ];
        }
      ];
  };

  testScript = ''
    start_all()
    ergo.wait_for_unit("multi-user.target")
    ergo.succeed("systemctl is-active ergochat.service || (journalctl --no-pager -u ergochat.service; false)")
    relay.wait_for_unit("weblounge-push-relay.service")
    relay.wait_for_unit("nginx.service")
    receiver.wait_for_unit("webpush-receiver.service")
    receiver.wait_for_unit("nginx.service")
    app.wait_for_unit("nginx.service")
    ergo.wait_for_open_port(6667)
    relay.wait_for_open_port(8098)
    receiver.wait_until_succeeds("nc -z ${addresses.receiver} 443")
    app.wait_for_open_port(443)

    app.succeed("rm -rf /tmp/weblounge-push-e2e")
    app.succeed("cp -r ${pushE2eHarness} /tmp/weblounge-push-e2e")
    app.succeed("chmod -R u+w /tmp/weblounge-push-e2e")
    app.succeed("""
      cd /tmp/weblounge-push-e2e &&
      export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers} \
        PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu-24.04 \
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true \
        __EGL_VENDOR_LIBRARY_FILENAMES=${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json \
        FONTCONFIG_FILE=${pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; }} \
        WEBLOUNGE_PUSH_FULL_E2E=1 \
        WEBLOUNGE_E2E_EXTERNAL_SERVER=1 \
        WEBLOUNGE_E2E_BASE_URL=https://app.test \
        WEBLOUNGE_E2E_SECURE_ERGO=1 \
        WEBLOUNGE_APP_DIR=${checkApp} \
        WEBLOUNGE_PUSH_APP_LINK=/var/lib/weblounge-push-app/current \
        WEBLOUNGE_PUSH_RELAY_CONTROL=http://${addresses.relay}:8098 \
        WEBLOUNGE_PUSH_RECEIVER_RECORDS=http://${addresses.receiver}:8080/requests.jsonl \
        WEBLOUNGE_E2E_IRC_HOST=${addresses.ergo} \
        WEBLOUNGE_E2E_IRC_PORT=6667 \
        WEBLOUNGE_E2E_IRC_API=http://${addresses.ergo}:8089/v1/saregister \
        WEBLOUNGE_E2E_IRC_API_TOKEN=weblounge-push-e2e-api &&
      cd app && node node_modules/@playwright/test/cli.js test \
        --project=chromium-push-full \
        --project=firefox-push-controls-full \
        --project=webkit-push-badge-full \
        --workers=1
    """)

    ergo.succeed("${pkgs.lib.getExe ergoProduction} --version | grep '2.19.1'")
    ergo.succeed("systemctl stop ergochat.service")
    ergo.succeed("mkdir -p /run/systemd/system/ergochat.service.d")
    ergo.succeed("cp ${pkgs.writeText "stock-ergo.conf" ''
      [Service]
      ExecStart=
      ExecStart=${pkgs.lib.getExe ergoProduction} run --conf /etc/ergo.yaml
    ''} /run/systemd/system/ergochat.service.d/stock.conf")
    ergo.succeed("systemctl daemon-reload && systemctl start ergochat.service")
    ergo.wait_until_succeeds("systemctl is-active ergochat.service && nc -z 127.0.0.1 6667")

    app.succeed("""
      cd /tmp/weblounge-push-e2e &&
      export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers} \
        PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu-24.04 \
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true \
        __EGL_VENDOR_LIBRARY_FILENAMES=${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json \
        FONTCONFIG_FILE=${pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; }} \
        WEBLOUNGE_PUSH_FULL_E2E=1 \
        WEBLOUNGE_PUSH_UNPATCHED_ERGO=1 \
        WEBLOUNGE_E2E_EXTERNAL_SERVER=1 \
        WEBLOUNGE_E2E_BASE_URL=https://app.test \
        WEBLOUNGE_E2E_SECURE_ERGO=1 \
        WEBLOUNGE_APP_DIR=${checkApp} \
        WEBLOUNGE_PUSH_APP_LINK=/var/lib/weblounge-push-app/current \
        WEBLOUNGE_PUSH_RELAY_CONTROL=http://${addresses.relay}:8098 \
        WEBLOUNGE_PUSH_RECEIVER_RECORDS=http://${addresses.receiver}:8080/requests.jsonl \
        WEBLOUNGE_E2E_IRC_HOST=${addresses.ergo} \
        WEBLOUNGE_E2E_IRC_PORT=6667 \
        WEBLOUNGE_E2E_IRC_API=http://${addresses.ergo}:8089/v1/saregister \
        WEBLOUNGE_E2E_IRC_API_TOKEN=weblounge-push-e2e-api &&
      cd app && node node_modules/@playwright/test/cli.js test \
        --project=chromium-push-unpatched-full \
        --workers=1
    """)
  '';
}
