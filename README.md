# personal-fin-os

A personal finance operating system.

## Branches

- `main` is the base branch. Start new work from it.
- `claude/*` branches hold work in progress and are merged back into `main`.

## Using ECC

This repo loads the [ECC](https://github.com/affaan-m/ECC) plugin (`ecc@ecc`) in Claude Code sessions. There is nothing to install by hand.

- `.claude/settings.json` declares the plugin and registers a startup hook.
- `.claude/hooks/session-start.sh` runs only in cloud sessions. It makes sure the plugin is installed and installs ECC's npm dependencies, which the plugin installer skips.
- [`docs/ecc-project-flow.html`](docs/ecc-project-flow.html) shows how to take a project from an idea to a merged pull request. Open it in a browser.

Things to know:

- Each cloud session installs ECC's current default branch, and ECC's hooks run its code in your session. Review ECC updates before you rely on them for anything sensitive.
- ECC's GateGuard hook asks for two facts before the first shell command of each session. To turn it off, set `ECC_GATEGUARD=off` in the environment.
- Keep statements and exports in `private/` or `statements/`. Both are git-ignored.
