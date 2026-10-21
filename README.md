# Build Spotter

Photograph a car or a part and get the car, each visible part, its specs, and shopping and fitment links. Installs to your phone's home screen.

## How the API key stays hidden

```
phone app  ──photo──▶  /api/analyze (Netlify function)  ──photo + your key──▶  AI service
                        key stored in Netlify settings
```

Your key is saved as an environment variable in your Netlify account. It's only read by the server function and never sent to anyone's browser. The function writes the AI instructions itself, so people can only use your key to analyze car photos, not as a free chatbot.

## Folder layout

| Path | What it is |
|---|---|
| `public/` | The app people see (page, icons, offline support) |
| `netlify/functions/analyze.mjs` | The server function that holds the key and calls the AI |
| `netlify.toml` | Tells Netlify where those two things are |

## Setup (no coding, about 15 minutes)

Netlify's drag-and-drop page is for plain websites. A site with a server function goes through GitHub, which is free and works from the browser.

**1. Put the files on GitHub**
1. Sign in at github.com and create a new repository at github.com/new. Name it `build-spotter`. Private is fine.
2. On the new repo's page, click **uploading an existing file**.
3. Unzip `build-spotter-app.zip`, open the `build-spotter-app` folder, select everything inside it (`netlify.toml`, `public`, `netlify`, `README.md`), and drag it onto the GitHub page. Click **Commit changes**.

**2. Connect it to Netlify**
1. In Netlify, go to **Add new project → Import an existing project → GitHub** and pick `build-spotter`.
2. Leave the build settings as they are (they're read from `netlify.toml`) and click **Deploy**.

**3. Add your key**
1. In the project, go to **Project configuration → Environment variables → Add a variable**.
2. Key: `AI_API_KEY`. Value: your API key. Tick **Contains secret values** if offered. Save.
3. Go to **Deploys → Trigger deploy → Deploy project** so the function picks up the key.

**4. Install on your phone**
Open the Netlify link. On iPhone (Safari): Share → **Add to Home Screen**. On Android (Chrome): ⋮ → **Install app**. It goes straight to the camera. No key prompt.

## Optional settings (same Environment variables screen)

| Variable | Use |
|---|---|
| `ACCESS_CODE` | Anyone using the app must enter this code once per device. Good if you share the link. |
| `AI_PROVIDER` | `anthropic` (default), `openai` or `gemini`, matching your key. |
| `AI_MODEL` | A different model. Defaults: `claude-sonnet-5-5`, `gpt-5.5`, `gemini-3.6-flash`. |
| `DONATE_URL` | Your donation page (must start with `https://`), e.g. a PayPal, Ko-fi or Buy Me a Coffee link. It appears in the opening notice. Leave it unset and the notice shows without the donation link. |

Redeploy after changing any variable.

## Protect your bill

Everyone who uses the app spends from your key. Set a monthly spend limit in your AI provider's console (in Anthropic's console, look under Limits) so a shared link can't run up a surprise bill. Each scan typically costs a few cents or less.

## Updating the app later

Upload the changed files to the same GitHub repo (same "upload files" button). Netlify redeploys automatically.

## If something goes wrong

- **App asks for an API key:** the function isn't running. Check that the `netlify` folder and `netlify.toml` made it into GitHub at the top level, not inside another folder.
- **"The app's server isn't set up yet":** `AI_API_KEY` is missing or wrong, or you didn't redeploy after adding it.
- **Errors after a scan:** Netlify → Logs → Functions → `analyze` shows the AI service's error message.
