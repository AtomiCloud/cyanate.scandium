{ atomi, pkgs, pkgs-2511, pkgs-unstable }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      {
        inherit
          atomiutils
          ;
      }
    );

    nix-2511 = (
      with pkgs-2511;
      {
        inherit
          git
          treefmt
          ;
      }
    );

    nix-unstable = (
      with pkgs-unstable;
      {
        inherit
          bun
          ;
      }
    );
  };
in
with all;
atomipkgs
// nix-2511
// nix-unstable
