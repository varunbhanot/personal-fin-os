# One-time setup guide

This guide is for a first-time user. Do the parts in order. Each part tells you where to put each value.

- **Time:** approximately 45 minutes.
- **Device:** a computer with a web browser is easiest. A phone also works.
- **Cost:** Neon, Doppler and Google Drive are free for this use. The Anthropic API uses your existing credit.
- **Labels:** the websites can change their button names. If a label is different, look for the nearest match, or ask Claude.

> **WARNING:** You will copy five secret values: statement passwords, an API key, a Google key, a Doppler token and a database connection string. Do not paste a secret into the Claude chat, an email, a message or a notes app. Paste each secret only into the place this guide shows.

## Where each value goes

| Value | Is it secret? | Where it goes |
|---|---|---|
| Statement passwords | Yes | Doppler |
| Anthropic API key | Yes | Doppler, as `ANTHROPIC_KEY` |
| Google service account key | Yes | Doppler, as `GDRIVE_SA_JSON` |
| Doppler service token | Yes | Cloud environment, "Network secrets" |
| Neon connection string | Yes | Cloud environment, "Network secrets" |
| Neon host | No | Cloud environment, "Environment variables" |
| Drive folder ID | No | Cloud environment, "Environment variables" |
| Doppler token for the laptop UI | Yes | macOS Keychain, at the hidden prompt (Part 10) |
| Neon string of the role `finos_ui` | Yes | Doppler, config `ui`, as `NEON_READONLY_URL` (Part 10) |

## Part 1. Make a Doppler project

Doppler keeps your secrets. Make it first, so you can paste each secret into it as soon as you get it.

1. Open https://dashboard.doppler.com in your browser.
2. Sign up. "Continue with Google" is the easiest choice.
3. If Doppler asks for a workplace name, type any name, for example your name.
4. Click **Create Project** (or the **+** next to "Projects").
5. Type the project name `finos`. Click **Create**.
6. Doppler makes three environments: Development, Staging and Production.
7. Click **Production**. Then click the config **prd**.
8. Keep this page open. All Doppler secrets in this guide go into **finos → prd**.

To add a secret in Doppler:

1. Click **Add Secret**.
2. Type the name in the left box. Type it exactly as this guide shows, in capital letters with underscores.
3. Paste the value in the right box.
4. Click **Save**.

## Part 2. Add your statement passwords to Doppler

A statement password is the password you type to open the statement PDF. The bank's email usually tells you its format.

1. In Doppler, **finos → prd**, add these secrets:

   | Name | Value |
   |---|---|
   | `PW_HDFC_TATANEU` | The password for the HDFC Tata Neu card statement |
   | `PW_SBI_CARD` | The password for the SBI Card Aurum statement |
   | `PW_AXIS_BANK` | The password for the Axis Bank statement |
   | `PW_SBI_BANK` | The password for the SBI bank account statement |

2. Click **Save**.

The Canara Bank statement has no password, so it needs no secret.

If you do not know a password now, skip it. Only `PW_HDFC_TATANEU` is necessary for the next session.

## Part 3. Make an Anthropic API key

The pipeline uses this key to send statements to Claude. The spend limit stops it from using too much of your credit.

1. Open https://console.anthropic.com. Sign in with the account that has your API credit.
2. Open **Settings → Workspaces**. Click **Create workspace**.
3. Type the name `finos`. Click **Create**.
4. Open the `finos` workspace. Find **Limits** (or **Spend limit**).
5. Set a monthly spend limit, for example $20. Save it.
6. Open **API keys**. Click **Create key**.
7. Select the workspace `finos`. Type the key name `finos-pipeline`. Click **Create**.
8. Copy the key. It starts with `sk-ant-`.

> **CAUTION:** The Console shows the key one time only. Paste it into Doppler now (step 9). If you lose it, delete it and make a new key.

9. In Doppler, **finos → prd**, add the secret `ANTHROPIC_KEY`. Paste the key as the value. Click **Save**.

## Part 4. Make the Google Drive folder and the Google key

The pipeline reads statement PDFs from one Google Drive folder. A "service account" is a robot Google account. It can only see the folder that you share with it.

### 4A. Make the folder

1. Open https://drive.google.com.
2. Click **New → New folder**. Type `Finance`. Click **Create**.
3. Open the `Finance` folder. Click **New → New folder**. Type `Statements`. Click **Create**.
4. Open the `Statements` folder.
5. Look at the address bar. The address looks like `https://drive.google.com/drive/folders/1AbCdEfGh...`.
6. Copy the part after `/folders/`. This is the **folder ID**. It is not secret. Keep it in a note for Part 7.

### 4B. Make the service account

1. Open https://console.cloud.google.com. If Google asks you to accept the terms, accept them.
2. At the top of the page, click the project list. Click **New project**.
3. Type the project name `finos`. Click **Create**.
4. Make sure that the top bar shows the project `finos`. If not, select it in the project list.
5. In the search bar at the top, type `Google Drive API`. Open the result. Click **Enable**.
6. Open the menu (☰). Click **IAM & Admin → Service Accounts**.
7. Click **Create service account**.
8. Type the name `finos-drive`. Click **Create and continue**.
9. Do not select a role. Click **Continue**. Then click **Done**.
10. Click the new service account in the list.
11. Copy its email address. It ends with `.iam.gserviceaccount.com`. It is not secret. You need it in 4C.
12. Open the **Keys** tab. Click **Add key → Create new key**.
13. Select **JSON**. Click **Create**. Your browser downloads a file.

> **CAUTION:** If Google shows "Service account key creation is disabled", your Google account belongs to a company or school. Stop, and tell Claude. Use a personal Google account if possible.

### 4C. Share the folder with the service account

1. In Google Drive, right-click the `Statements` folder. Click **Share**.
2. Paste the service account email address from step 4B.11.
3. Set the role to **Viewer**.
4. Clear the **Notify people** box.
5. Click **Share**. If Drive warns that the address is outside your organisation, click **Share anyway**.

### 4D. Put the Google key in Doppler

1. Open the downloaded JSON file with a text editor: Notepad on Windows, or TextEdit on a Mac.
2. Select all of the text. Copy it.
3. In Doppler, **finos → prd**, add the secret `GDRIVE_SA_JSON`. Paste all of the text as the value. Click **Save**.
4. Delete the downloaded JSON file from your computer. Then empty the recycle bin.

## Part 5. Make the Neon database

Neon keeps your financial record. The record stays after each Claude session ends.

1. Open https://console.neon.tech. Sign up. "Continue with Google" is the easiest choice.
2. When Neon asks you to make a project:
   - **Project name:** `finos`
   - **Postgres version:** keep the default
   - **Region:** select the region nearest to you, for example Asia Pacific (Singapore)
3. Click **Create project**.
4. On the project page, click **Connect**.
5. If you see a **Connection pooling** switch, turn it off.
6. Click **Show password**. Then copy the **connection string**. It looks like this:
   `postgresql://neondb_owner:AbC123xyz@ep-quiet-sky-a1b2c3d4.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
7. Keep this page open. You need three items from it in Part 7:
   - **The connection string:** all of the text from step 6. It is secret.
   - **The host:** the text after `@` and before the next `/`, for example `ep-quiet-sky-a1b2c3d4.c-2.ap-southeast-1.aws.neon.tech`. It is not secret.
   - **The API address:** the host with its first part (up to the first dot) replaced by `api`, for example `api.c-2.ap-southeast-1.aws.neon.tech`. It is not secret.
8. Look for a part such as `c-2` or `c-3` after the first dot of the host. New Neon projects have it. Older projects do not.

> **CAUTION:** Keep the `c-` part in the host and in the API address. If you remove it, the pipeline cannot reach the database. `finos check` shows the API address that it uses.

## Part 6. Make the Doppler service token

The token lets the pipeline read the `finos → prd` secrets. It can only read. It cannot change anything.

1. In Doppler, open **finos → prd**.
2. Open the **Access** tab.
3. Under **Service Tokens**, click **Generate**.
4. Type the name `claude-cloud`. Set the access to **Read**. If you can set an expiry, select 1 year.
5. Click **Generate**. Copy the token. It starts with `dp.st.prd.`.

> **CAUTION:** Doppler shows the token one time only. Keep this page open until Part 7, step 10.

## Part 7. Make the Claude cloud environment

The cloud environment is the computer where Claude runs the pipeline. You give it the two network secrets and two settings.

1. Open https://claude.ai/code. Open any session for the `personal-fin-os` repository.
2. In the title bar of the session, click the environment name.
3. Click **Add environment** (or **New environment**).
4. Type the name `finos`.
5. Set **Network access** to **Custom**.
6. In **Allowed domains**, type these two lines:
   ```
   www.googleapis.com
   oauth2.googleapis.com
   ```
7. Keep **Also include default list of common package managers** selected.
8. In **Environment variables**, type these two lines. Put your own values after the `=` signs:
   ```
   FINOS_NEON_HOST=ep-quiet-sky-a1b2c3d4.c-2.ap-southeast-1.aws.neon.tech
   FINOS_DRIVE_FOLDER_ID=1AbCdEfGh...
   ```
   Use the Neon host from Part 5, step 7, and the folder ID from Part 4A, step 6. Do not type a password or key here.
9. Save the environment. Then open it again with **Edit**.
10. Find **Network secrets**. Click **Add secret**. Fill in the Doppler secret:
    - **Secret type:** Bearer (keep this)
    - **Name:** `Doppler finos`
    - **Allowed websites:** `api.doppler.com`
    - **Custom headers:** keep the header name `Authorization` and the prefix `Bearer`. Paste the Doppler token (Part 6) as the **Value**.
    - Click **Add**.
11. Click **Add secret** again. Fill in the Neon secret:
    - **Secret type:** Bearer (keep this)
    - **Name:** `Neon finos`
    - **Allowed websites:** the API address from Part 5, step 7, for example `api.c-2.ap-southeast-1.aws.neon.tech`
    - **Custom headers:** change the header name from `Authorization` to `Neon-Connection-String`. Delete the prefix `Bearer` so that the prefix is empty. Paste the Neon connection string as the **Value**.
    - Click **Add**.
12. Make sure that the list shows both secrets with their websites.

If a secret shows **Not sent**, read the note under it, and tell Claude what it says.

> **CAUTION:** If the form has no **Custom headers** part, add only the Doppler secret, and tell Claude. Claude will change the code to read the Neon connection string from Doppler.

## Part 8. Turn on two-factor sign-in

Two-factor sign-in stops another person from using a stolen password on these accounts.

1. Turn on two-factor sign-in (also called 2-step verification or multi-factor authentication) for each of these accounts:
   - Google: https://myaccount.google.com/security
   - Doppler: your profile settings
   - Neon: your account settings
   - Anthropic Console: your account settings
   - claude.ai: your account settings, if it offers it

## Part 9. Put one statement in the folder and start

1. Open the email with your latest HDFC Tata Neu statement.
2. Save the PDF attachment into Google Drive, in **Finance → Statements**. In Gmail, the attachment has a **Save to Drive** button.
3. Start a new Claude Code session. Select the repository `personal-fin-os` and the environment `finos`.
4. Type: `Setup is done. Continue the statement pipeline on branch claude/statement-pipeline-plan.`
5. Claude runs `finos check` and tells you if a part needs a correction.

## Part 10. Laptop UI (optional)

The laptop UI shows a dashboard and a chat for your record. It runs on your Mac. Only you start it. Claude never starts it.

Do this part after Part 9, when the pipeline runs and the pull request of the BI UI is on `main`.

> **WARNING:** Do not type a secret in the Claude chat. Enter it only in Doppler, in the `psql` line of 10B, step 5, or at the hidden prompt of `security add-generic-password`.

> **WARNING:** Do not make `ui` as a branch config of `prd`. A branch config gets all statement passwords, the Google key and the Anthropic key of the cloud.

### 10A. Check the laptop

1. Run `node --version` in Terminal.
2. Make sure that the version is 22.12 or later 22.x, 24.x, or 26 or later. Node 23 and 25 do not work.

### 10B. Make the database role

The UI reads the record with a role that can read only safe views. The role cannot read a narration, a handle or a note.

> **CAUTION:** Make the role in `psql`. Do not make it in the Neon Console. A role from the Console joins `neon_superuser`, and its grants have no effect.

1. In a cloud session with the environment `finos`, ask Claude to run `uv run finos check`. This runs the migrations 0008 and 0009.
2. On the laptop, open `psql` with the owner connection string from the Neon Console.
3. Run `create role finos_ui login in role finos_ui_access connection limit 10;`
4. Run `alter role finos_ui set statement_timeout = '15s';`
5. Set the password. Do not use `\password`: Neon refuses it.
   1. In a second Terminal window, run `openssl rand -hex 24`. Copy the output. It has only letters and digits, so the URL of 10C needs no encoding.
   2. In `psql`, run `\set HISTCONTROL ignorespace`. Then `psql` does not keep a line that starts with a space.
   3. Type a space, then `alter role finos_ui with password '<the password>';`
   4. Make sure that `psql` shows `ALTER ROLE`. Keep the password for 10C, step 2.
6. Run `select rolsuper from pg_roles where rolname = 'finos_ui';`
7. Run `select pg_has_role('finos_ui', 'neon_superuser', 'member');`
8. Run `select has_table_privilege('finos_ui', 'transactions', 'select');`
9. Make sure that the three results are `f`. If one is `t`, stop and tell Claude.

### 10C. Make the Doppler config

> **CAUTION:** `ANTHROPIC_KEY` in config `ui` is the same key as the pipeline key. If you revoke or rotate it, `finos sync` also stops. Then update both configs.

1. In the Doppler project `finos`, make a new environment. Type the name `ui`. Its root config is `ui`.
2. In config `ui`, add `NEON_READONLY_URL`. Use the role `finos_ui`, the password of 10B, and `sslmode=require`.
3. In config `prd`, copy the value of `ANTHROPIC_KEY`.
4. In config `ui`, add `ANTHROPIC_KEY` with that value. Add no other secret.
5. In config `ui`, make a **read-only** service token. Set an expiry, for example 90 days.
6. Copy the token. It starts with `dp.st.ui.`.

### 10D. Put the token in the Keychain

1. In Terminal, run `security delete-generic-password -s finos-ui -a doppler`. Ignore a "could not be found" message.
2. Run `security add-generic-password -s finos-ui -a doppler -T "" -w`. Do not add `-U`.
3. Paste the token at the hidden prompt. Run this command yourself, not through Claude.

### 10E. Set the shell profile

1. Open your shell profile, for example `~/.zshrc`.
2. Add `export FINOS_NEON_HOST=` with the Neon host only. Use the host of Part 5, step 7.
3. Add `export FINOS_AI_BUDGET_USD=` with the same value as in the cloud environment. The default is 100.
4. Open a new Terminal window.

### 10F. Build and check

1. In Terminal, go to the repository folder.
2. Run `npm --prefix ui run build`. It runs `npm ci --ignore-scripts` for the web app and the server.
3. Run `npm --prefix ui run ui-check`.
4. Make sure that the check shows the budget value of 10E.

Do not run `npm install`. It runs install scripts from the internet.

### 10G. Start the UI

1. Run `npm --prefix ui run ui`.
2. Wait for the Keychain prompt. The first start must show it. If no prompt shows, press Control-C and do 10D again.
3. Choose **Allow** right after you started the server. Do not choose **Always Allow**.
4. Wait for the browser. It shows the dashboard and the chat.
5. To stop the server, press Control-C in Terminal.

If port 8765 is in use, run `npm --prefix ui run ui -- --port 8766`.

If the server shows "The database refused a query (code unknown)", the laptop cannot reach Neon. Run `nslookup <your Neon host>`. If it fails, the DNS server of the network does not find the host. In System Settings, Network, Details, DNS, add `1.1.1.1` and `8.8.8.8`. Then start the server again.

If the browser shows "This launch link was used twice", another program used the link. Start the server again. Tell Claude in a cloud session.
