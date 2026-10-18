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
   | `PW_CANARA_LOAN` | The password for the Canara Bank loan statement |

2. Click **Save**.

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
   `postgresql://neondb_owner:AbC123xyz@ep-quiet-sky-a1b2c3d4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
7. Keep this page open. You need three items from it in Part 7:
   - **The connection string:** all of the text from step 6. It is secret.
   - **The host:** the text after `@` and before the next `/`, for example `ep-quiet-sky-a1b2c3d4.ap-southeast-1.aws.neon.tech`. It is not secret.
   - **The API address:** the host with its first part (up to the first dot) replaced by `api`, for example `api.ap-southeast-1.aws.neon.tech`. It is not secret.

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
   FINOS_NEON_HOST=ep-quiet-sky-a1b2c3d4.ap-southeast-1.aws.neon.tech
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
    - **Allowed websites:** the API address from Part 5, step 7, for example `api.ap-southeast-1.aws.neon.tech`
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
