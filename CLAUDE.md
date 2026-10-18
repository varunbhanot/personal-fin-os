# personal-fin-os

Base branch is `main`. New work happens on a branch cut from it and comes back through a pull request.

## ECC

The ECC plugin (`ecc@ecc`, from https://github.com/affaan-m/ECC) is wired in through `.claude/settings.json`. In cloud sessions `.claude/hooks/session-start.sh` installs it and its npm dependencies at startup. Its commands are namespaced `/ecc:<name>`.

To build something, follow `docs/ecc-project-flow.html`:

- New project from a spec: `/ecc:orch-build-mvp <spec file>`. With only an idea, run `/ecc:plan-prd "<idea>"` first. It writes `.claude/prds/<name>.prd.md`.
- Other work: `/ecc:orch-add-feature`, `/ecc:orch-fix-defect`, `/ecc:orch-change-feature`, `/ecc:orch-refine-code`.
- These run one sequence: plan, test-first implementation, review, commit. Stop at the two gates and wait for the user: approve the plan before writing code, and confirm the commit before committing.
- Open pull requests with the GitHub tools. ECC's `/ecc:pr` runs `gh pr create`, which cloud sessions block.
- ECC's GateGuard hook asks for two facts before the first shell command of a session (the user's request, and what the command does). State them and retry the command.
- Keep specs and plans in the repo. A cloud container starts fresh, so anything under `~/.claude` is gone next session.

## Financial data

Never commit statements, exports or account details. Keep them in `private/` or `statements/`, which are git-ignored.
