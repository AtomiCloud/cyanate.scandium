{ pkgs, packages }:
with packages;
{
  dev = [
    git
  ];

  lint = [
    treefmt
  ];

  main = [
    bun
  ];

  system = [
    atomiutils
  ];
}
