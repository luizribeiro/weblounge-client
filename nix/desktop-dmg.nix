{ pkgs, desktop }:
let
  # libisofs gives every HFS+ file the Finder type and creator "????", which macOS exposes as a
  # com.apple.FinderInfo xattr; `codesign --verify --strict` rejects that as detritus.
  libisofs = pkgs.libisofs.overrideAttrs (old: {
    postPatch = (old.postPatch or "") + ''
      substituteInPlace libisofs/hfsplus.c --replace-fail '"????", 4' '"\0\0\0\0", 4'
    '';
  });
  xorriso = pkgs.libisoburn.override { inherit libisofs; };
in
# hdiutil cannot run in the sandbox, so the image is an ISO 9660 / HFS+ hybrid, which macOS
# mounts through its Apple partition map.
pkgs.runCommand "weblounge-desktop-dmg"
  {
    nativeBuildInputs = [ xorriso ];
    meta.platforms = pkgs.lib.platforms.darwin;
  }
  ''
    ln -s /Applications Applications
    mkdir -p $out
    xorrisofs -volid Weblounge -hfsplus -apm-block-size 2048 -rational-rock \
      -graft-points -output $out/Weblounge.dmg \
      Weblounge.app=${desktop}/Applications/Weblounge.app Applications=Applications
    if LC_ALL=C grep -qa '????????' $out/Weblounge.dmg; then
      echo "Weblounge.dmg still carries Finder type/creator codes" >&2
      exit 1
    fi
  ''
