# Secrets in Claude Code cloud sessions: research notes

Researched 2026-10-18 for the statement pipeline (`.claude/plans/statement-pipeline.plan.md`). These notes bring together three sources: Anthropic's documentation, what developers report doing, and the docs of each secret manager. I checked the cloud-environments page myself. The rest comes from research summaries, so confirm anything marked "unconfirmed" before relying on it.

## 1. What Anthropic recommends

- **Environment variables are not for secrets.** "Anyone who uses the environment can read the values. In an Anthropic-hosted environment, use a network secret instead for a key the agent proxy can attach to a request." ([cloud environments](https://code.claude.com/docs/en/cloud-environments))
- **Network secrets keep a key outside the VM.** "Anthropic's agent proxy adds the key to requests for the hosts you list, after each request leaves the session's VM, so the key itself stays outside the VM." The value can't be viewed after saving, and the hosts it applies to are reachable even under restricted network access. (same page)
- **When no proxy can help, the fallback is an environment variable.** "A key the agent proxy can't attach stays in an environment variable." (same page)
- **Anthropic's own design principle** is to "run a proxy outside the agent's security boundary that injects credentials" ([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)), so that "sensitive credentials … are never inside the sandbox" ([sandboxing post](https://www.anthropic.com/engineering/claude-code-sandboxing)).

### Network secrets: the details that matter here

- **Plans:** Pro, Max, Team and Enterprise. On Team without an admin role, the form is shorter: one host, type Token or Username and password. ([cloud environments](https://code.claude.com/docs/en/cloud-environments))
- **Secret types:** Bearer and custom headers (name, prefix, value). Other types are "the same [list] Claude Tag offers", which includes **GCP access token from a service-account key, where the proxy does the token exchange**, as well as AWS SigV4 and OAuth client credentials. ([Claude Tag custom connections](https://claude.com/docs/claude-tag/admins/connections/custom)). **Unconfirmed:** whether a personal plan's environment form shows all of these.
- **Hosts that never get a secret:** `api.anthropic.com`, the package registries, GitHub, and requests from setup scripts. Secrets are attached only after Claude Code starts.
- **Local use is impossible.** A network secret can't decrypt a file inside the VM, because the value is never in the VM. Statement PDF passwords therefore have to be fetched into memory at run time.
- **Unconfirmed:** whether the proxy replaces an authorization header the client already sends, or adds a second one. Test this.

### Other official points

- **Network levels** are None, Trusted, Full and Custom. **Trusted already includes `*.googleapis.com`**, so it isn't a tight allowlist. GitHub, enabled MCP connectors and network-secret hosts bypass the allowlist at every level: "Turn off any connector you don't need." ([cloud environments](https://code.claude.com/docs/en/cloud-environments))
- **The Anthropic API is always reachable**, "which may allow data to exit the VM". ([Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web))
- **Setup scripts get no network secrets.** Their output is also cached as a filesystem snapshot for about 7 days, so never write secrets to disk in a setup script.
- **Transcripts are stored by Anthropic**, and a shared session "may contain code and credentials". ([data usage](https://code.claude.com/docs/en/data-usage))
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`** strips credentials from the environment of the commands Claude runs. ([env vars](https://code.claude.com/docs/en/env-vars))
- **Routines** (scheduled cloud sessions) use the same environments and the same advice: store keys as network secrets. ([routines](https://code.claude.com/docs/en/routines))
- **There's no official recommendation for persistent state** beyond "commit it to the repo". Using an external database is our own decision.

## 2. What developers do

1. **A secret-manager CLI wraps the command** (`op run`, `doppler run`, Infisical). This is the most common advice, but it's written for a local CLI. In a cloud session, its bootstrap token would sit in a readable environment variable. ([1Password, Sept 2026](https://www.1password.community/developers-blog-53/why-claude-code-and-1password-are-the-perfect-match-25455), [Doppler](https://www.doppler.com/agents-claude-code))
2. **Deny rules on `.env` files** are widely used but only partial. They don't stop a script from opening a file itself. ([permissions](https://code.claude.com/docs/en/permissions), [The Register, Jan 2026](https://www.theregister.com/2026/01/28/claude_code_ai_secrets_files/))
3. **Proxy injection (network secrets)** is the strongest option for cloud sessions. It launched for personal accounts around mid-September 2026 ([issue #32733](https://github.com/anthropics/claude-code/issues/32733)), so most write-ups predate it.
4. **Hooks and redaction** help, but they're not airtight. Claude has printed secrets despite instructions, including a GCP key and a full Vault dump ([#32616](https://github.com/anthropics/claude-code/issues/32616), [#65122](https://github.com/anthropics/claude-code/issues/65122)).
5. **Least privilege:** read-only scoped tokens, expiry, and a separate Anthropic Console workspace with a spend limit for each project.

### Pitfalls reported

- **`ANTHROPIC_API_KEY` set in a cloud environment** broke sessions ([#54497](https://github.com/anthropics/claude-code/issues/54497)). Another user reports it moved all Claude Code usage onto API billing ([HN](https://news.ycombinator.com/item?id=47966935)). **Never use that name for the pipeline's key.**
- **Direct Postgres connections (ports 5432/6543) are blocked** in cloud sessions, even with Full access ([#22332](https://github.com/anthropics/claude-code/issues/22332), [#60256](https://github.com/anthropics/claude-code/issues/60256)). This session's own test agrees. Use HTTP APIs instead.
- **Prompt injection reading the process environment** (`/proc/self/environ`) has happened in the past ([Microsoft, Jun 2026](https://microsoft.com/en-us/security/blog/2026/06/05/securing-ci-cd-in-agentic-world-claude-code-github-action-case)). It argues for keeping nothing secret in environment variables.

## 3. Secret managers the proxy can unlock

A secret manager fits this design only if its API takes a fixed header credential that the proxy can attach.

| Service | Fixed header credential? | Verdict |
|---|---|---|
| **Doppler** | Yes: `Authorization: Bearer dp.st.…` on `api.doppler.com` ([API](https://docs.doppler.com/reference/api), [download](https://docs.doppler.com/reference/secrets-download)) | **Best fit.** The token is read-only and limited to one config, with optional expiry ([service tokens](https://docs.doppler.com/docs/service-tokens)). The free Developer plan includes an access log kept for 3 days ([pricing](https://www.doppler.com/pricing), [access logs](https://docs.doppler.com/docs/access-logs)). |
| Infisical | Yes, with Token Auth (Bearer) ([token auth](https://infisical.com/docs/documentation/platform/identities/token-auth)) | A good runner-up and open source. No audit log on the free plan. |
| HashiCorp Vault | Yes (`X-Vault-Token`) | Works, but you'd have to run and expose a server. |
| 1Password, Bitwarden | No. Values are decrypted on the client, so the token must be in the VM ([1Password](https://www.1password.dev/service-accounts/security/), [Bitwarden](https://bitwarden.com/help/access-tokens/)) | Doesn't fit. |
| AWS, Google, Azure secret managers | No. They need signed requests or short-lived OAuth tokens ([Google token types](https://docs.cloud.google.com/docs/authentication/token-types)) | Doesn't fit. Google might work through the proxy's GCP token type, which is unconfirmed. |
| Neon | No secrets feature ([extensions](https://neon.com/docs/extensions/pg-extensions)) | An encrypted table plus a key in an environment variable is the do-it-yourself option. |

No published write-up combines network secrets with a secret manager yet. The design below is assembled from the documented pieces, so the first task tests it.

## 4. Conclusion used in the plan

- **Proxy-injected:** the Neon credential and the Doppler token, as network secrets. Possibly the Google service-account key too, if the GCP token type is offered.
- **Stored in Doppler and read into memory at run time:** the statement passwords and the Anthropic key, plus the Google key if the proxy can't handle it.
- **In the environment:** no secrets at all.
- **Remaining risk:** code running in a session can still read the secrets while it runs. That risk is limited by scoped and capped credentials, Custom network access, unneeded connectors turned off, a guard hook, and extraction calls that have no tools.
