{ formatter, pre-commit-lib }:
pre-commit-lib.run {
  src = ../.;

  hooks = {
    treefmt = {
      enable = true;
      package = formatter;
      excludes = [ ];
    };
  };
}
