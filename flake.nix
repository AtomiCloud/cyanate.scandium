{
  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";

    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-2511.url = "github:NixOS/nixpkgs/nixos-25.11";
    atomipkgs.url = "github:AtomiCloud/nix-registry/v2";
  };

  outputs =
    { self
    , flake-utils
    , treefmt-nix
    , pre-commit-hooks
    , atomipkgs
    , nixpkgs-2511
    , nixpkgs-unstable
    }:
    flake-utils.lib.eachDefaultSystem
      (
        system:
        let
          pkgs-2511 = nixpkgs-2511.legacyPackages.${system};
          pkgs-unstable = nixpkgs-unstable.legacyPackages.${system};
          atomi = atomipkgs.packages.${system};
          pkgs = pkgs-2511;
          pre-commit-lib = pre-commit-hooks.lib.${system};
          formatter = import ./nix/fmt.nix {
            inherit treefmt-nix pkgs;
          };
          packages = import ./nix/packages.nix {
            inherit pkgs pkgs-2511 pkgs-unstable atomi;
          };
          env = import ./nix/env.nix {
            inherit pkgs packages;
          };
          pre-commit = import ./nix/pre-commit.nix {
            inherit formatter pre-commit-lib;
          };
          checks = {
            pre-commit-check = pre-commit;
            format = formatter;
          };
          devShells = import ./nix/shells.nix {
            inherit pkgs env packages;
            shellHook = checks.pre-commit-check.shellHook;
          };
        in
        {
          inherit checks formatter packages devShells;
        }
      );
}
