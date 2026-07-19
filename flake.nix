{
  description = "OpenCode development flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    re-nixpkgs.url = "github:ReStranger/re-nixpkgs";
  };

  outputs =
    { self, nixpkgs, re-nixpkgs, ... } @ inputs:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      rev = self.shortRev or self.dirtyShortRev or "dirty";
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            re-nixpkgs.packages.${pkgs.system}.bun-canary
            nodejs_26
            pkg-config
            openssl
            git
          ];
        };
      });

      overlays = {
        default =
          final: _prev:
          let
            node_modules = final.callPackage ./nix/node_modules.nix {
              inherit rev inputs;
            };
          in
          rec {
            opencode = final.callPackage ./nix/opencode.nix {
              inherit node_modules inputs;
            };
            opencode-desktop = final.callPackage ./nix/desktop.nix {
              inherit opencode inputs;
            };
          };
      };

      packages = forEachSystem (
        pkgs:
        let
          node_modules = pkgs.callPackage ./nix/node_modules.nix {
            inherit rev inputs;
          };
        in
        rec {
          default = opencode;
          opencode = pkgs.callPackage ./nix/opencode.nix {
            inherit node_modules inputs;
          };
          opencode-desktop = pkgs.callPackage ./nix/desktop.nix {
            inherit opencode inputs;
          };
          # Updater derivation with fakeHash - build fails and reveals correct hash
          node_modules_updater = node_modules.override {
            hash = pkgs.lib.fakeHash;
          };
        }
      );
    };
}
