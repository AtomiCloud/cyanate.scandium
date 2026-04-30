{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";
    programs = { };
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
