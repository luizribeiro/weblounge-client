Test-only images for `../../fake-filehost-server.mjs`, the HTTPS file host that local Ergo
advertises as `draft/FILEHOST` in e2e runs. The server generates a fresh self-signed certificate
for `127.0.0.1` at startup (`../../self-signed-certificate.mjs`); browsers accept it through
Playwright's `ignoreHTTPSErrors`.

Regenerate the images:

```sh
nix shell nixpkgs#imagemagick -c sh -c '
  magick -size 640x480 gradient:"#3b6ea8-#c9d8ea" -strip landscape.png
  magick -size 1600x200 gradient:"#a83b6e-#eac9d8" -strip wide.png
  magick -size 120x800 gradient:"#3ba86e-#c9ead8" -strip tall.png
  magick -delay 20 -size 160x120 xc:"#e0a030" xc:"#3060e0" -loop 0 animated.gif'
```
