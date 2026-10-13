# Delyan Iliev's agent skills

Skills for coding agents that read `SKILL.md`, such as Claude Code and GitHub Copilot.

| Skill | What it does |
| --- | --- |
| [frontend-pr-evidence](skills/frontend-pr-evidence/SKILL.md) | Records a PR's UI at the merge base and at the head, using the same fixtures, viewport, and clicks. Then it posts a side-by-side screenshot and video as one PR comment through `gh`. |

## Install

These steps are written so that a person or an agent can run them in order.

1. **Add the skill** with the [skills CLI](https://github.com/vercel-labs/skills):

   ```sh
   npx skills add diliev1996/delyan-iliev-skills --skill frontend-pr-evidence -g -y -a claude-code -a github-copilot
   ```

   The `-a` flags name the agents to install for; change them to the agents you use. Without the CLI, copy `skills/frontend-pr-evidence` into your agent's skills directory, for example `~/.claude/skills/`.

2. **Install the requirements:**
   - Node.js 20 or later.
   - Playwright 1.64 and Chromium, in the cache folder the skill's scripts load them from:

     ```sh
     npm install --prefix "$HOME/.cache/frontend-pr-evidence" playwright@~1.64 && "$HOME/.cache/frontend-pr-evidence/node_modules/.bin/playwright" install chromium
     ```

   - The GitHub CLI, signed in to the host where your PRs live. Check with `gh auth status`. Your `gh` version must list `--attach` under `gh pr comment --help`.

3. **Verify** by running the skill's tests from the folder it was installed to:

   ```sh
   node ~/.agents/skills/frontend-pr-evidence/scripts/capture.test.cjs
   ```

   The install is done when all seven lines print `PASS`. This takes about a minute. The tests use a stub `gh` and post nothing to GitHub.

## License

[MIT](LICENSE)
