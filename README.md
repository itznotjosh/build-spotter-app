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
| `netlify/functions/analyze.mjs` | The server function that holds the key, takes a credit and calls the AI |
| `netlify/functions/credits.mjs`, `checkout.mjs`, `stripe-webhook.mjs` | Balance, Stripe checkout, and adding credits after payment |
| `netlify/lib/accounts.mjs` | Shared account, credit and Stripe code; pack prices live here |
| `supabase/schema.sql` | Run once in Supabase to create the credit tables |
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

## Accounts, credits and payments

Once this is set up, people sign in with email and password before scanning. Each scan costs 1 credit:

- **5 free scans every month** per account. They refill on the 1st (UTC) and don't roll over.
- **Bought scans** never expire: 20 for $2.99, 50 for $5.99, 120 for $11.99. Free scans are used first.
- Re-checking with **Edit name** or **Update results** also uses 1 scan. A scan that fails is refunded automatically.
- Payments go through Stripe Checkout. Card details never touch your site.

```
app ── sign in ──▶ Supabase (accounts + balances)
app ── scan ─────▶ /api/analyze ── takes 1 credit ──▶ AI
app ── buy ──────▶ /api/checkout ──▶ Stripe ──▶ /api/stripe-webhook ── adds credits
```

Until the Supabase variables below are set, the app works exactly as before (no accounts, no credits).

**A. Supabase (accounts and balances), about 10 minutes**
1. Create a free project at supabase.com.
2. **SQL Editor → New query**, paste everything in `supabase/schema.sql`, click **Run**.
3. **Authentication → URL Configuration**: set **Site URL** to your Netlify link (e.g. `https://build-spotter.netlify.app`) and add the same link under **Redirect URLs**. Email confirmation and password-reset links come back here.
4. **Project Settings → API**: copy the **Project URL**, the **anon public** key and the **service_role** key.

**B. Stripe (payments), about 10 minutes**
1. Create a Stripe account. Leave it in **Test mode** at first.
2. **Developers → API keys**: copy the **Secret key** (`sk_test_…`).
3. **Developers → Webhooks → Add endpoint**. URL: `https://YOUR-SITE.netlify.app/api/stripe-webhook`. Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Save, then copy its **Signing secret** (`whsec_…`).

**C. Add the variables in Netlify** (Environment variables, tick **Contains secret values** for the secret ones), then redeploy:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_ANON_KEY` | Supabase anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key (secret) |
| `STRIPE_SECRET_KEY` | Stripe secret key (secret) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (secret) |
| `FREE_SCANS_PER_MONTH` | Optional. Default `5`. |
| `CREDIT_PACKS` | Optional. Change prices, e.g. `[{"id":"p20","credits":20,"cents":299},{"id":"p50","credits":50,"cents":599,"tag":"Most popular"}]` |
| `CURRENCY` | Optional. Default `usd`. |
| `GUIDE_MODEL` | Optional. A different model for Creative mode only, e.g. `claude-haiku-5-5` for faster, cheaper replies. Defaults to `AI_MODEL`. |
| `MESHY_API_KEY` | Optional. Your Meshy API key (meshy.ai → API). Turns on the 3D garage in Creative mode. |
| `GARAGE_START_COST` / `GARAGE_UPDATE_COST` | Optional. Scans a user pays to turn the 3D garage on for a build (first version of their car), and for each new version. Defaults `5` and `4`. |
| `MESHY_IMAGE_MODEL` | Optional. Meshy's image model for drawing the car's views. Default `nano-banana-2`; `nano-banana-pro` looks better but needs a Meshy Pro plan and costs more. |
| `GUIDE_REPLIES_PER_SCAN` | Optional. Creative mode: how many build-guide replies one scan buys. Default `15`. |
| `SIGNUP_BONUS` | Optional. Scans given once to every account created during the sign-up sale. Default `20`; `0` turns the sale off. |
| `SIGNUP_BONUS_STARTS` / `SIGNUP_BONUS_ENDS` | Optional. When the sale runs, as ISO times. Defaults: `2026-11-20T05:00:00Z` (12:00 AM Eastern, Friday Nov 20) to `2026-11-28T05:00:00Z` (midnight Eastern as Black Friday ends). |

**D. Test it.** Make an account, scan 5 times, and the 6th scan asks you to buy a pack. Pay with Stripe's test card `4242 4242 4242 4242`, any future date, any CVC. You land back in the app with the scans added. When it works, switch Stripe to live mode, make a live webhook the same way, and replace both Stripe variables with the live values.

**Creative mode (AI build guide).** From the home screen, people enter their car (year, make, model, generation, trim or engine, transmission, drivetrain, what's already done, budget) and chat with an AI guide about what they want to do. The guide asks follow-up questions when it needs them (shown as tappable answers), then recommends specific parts with the fitment for that car, a price estimate, the order to do things, and warnings, each part with the same shop / eBay / fitment links as a scan. A scan result also has "Plan mods for this car", which starts a build with that car filled in. Server side it is `netlify/functions/guide.mjs` (`/api/guide`), with its instructions in `netlify/lib/guide-prompt.mjs` (copied into `index.html` for keyless copies of the app). A build session costs 1 scan and includes `GUIDE_REPLIES_PER_SCAN` replies; a failed reply is given back. Each build has its own session, so replies left in one build never move to another. Guide replies are streamed: the guide's message appears in the chat word by word while it writes, then the part cards appear when it finishes. Streaming also keeps long answers within Netlify's limits (streamed functions can run for up to 60 seconds). With Anthropic, the guide answers by filling a fixed form (a forced tool call), so its answer is always valid JSON; an answer that runs out of room keeps what was written and says it was cut short. In a chat, "Save and exit" goes back to the builds list and "New build" starts a fresh one; a reply still on its way when you leave lands in its own build. It needs the Creative mode block at the end of `supabase/schema.sql` (table `guide_chats`, functions `bs_guide_turn` and `bs_guide_undo`), so run the updated script once. Builds are saved on the person's device.

**3D garage (Creative mode, made with Meshy).** An optional, paid extra on each build. The user turns it on (optionally with up to 3 photos of their car and its paint colour) and gets version 1: a 3D model of their car they can turn, zoom and spin. From then on, every time they tap **Add to my 3D car** on one of the guide's parts (wheels, tyres, suspension, body and aero such as widebody kits, lighting, exhaust), type in a part of their own, or remove one, the garage makes a new version of the car with the change. Parts added close together go into one version. Every version stays in the list to compare. (A switch turns automatic versions off, so the user presses "Make it now" instead.)

How a version is made, and how it stays the same car:
1. **Drawing.** Meshy draws matching studio views of the car from several angles. Version 1 comes from the user's photos (or from the car's year, make, model and generation if there are none). Every later version is drawn by editing the *previous version's views* plus version 1's front view, with instructions to change only the new parts and keep the body, paint colour and tone, lights, angles and earlier parts exactly as they are. So each version remembers the last one and never drifts from the original car.
2. **Modelling.** Meshy builds the 3D model from those views, with its finer geometry setting, lighting removed from the texture, and instructions for one even paint tone and smooth panels with no bumps or blotches.
While the model is being built, the app shows the drawn views, so the user sees the change in a minute or two. A version takes about 3 to 5 minutes in all, and keeps going if the user leaves the build.

Set up: add `MESHY_API_KEY` in Netlify, run the updated `supabase/schema.sql` once (it adds the `garage_jobs` table and a public `garage` storage bucket), and redeploy. Server side it is `netlify/functions/garage.mjs` (`/api/garage`) and `netlify/lib/garage.mjs`; the instructions sent to Meshy are in `firstDesign`, `nextDesign`, `modLine` and `modelBody` there, if you want to tune them. Each version's views and model are copied to the Supabase bucket, because Meshy deletes its files after 3 days and later versions need the earlier views. Without accounts (for example when you run it locally without Supabase) files come straight from Meshy and last 3 days.

Cost: about 41 Meshy credits per version (6 for the views with `nano-banana-2`, 30 for the textured model, 5 for the finer geometry; check Meshy's pricing page). Users pay `GARAGE_START_COST` scans to turn it on and `GARAGE_UPDATE_COST` per new version. A version that fails gives its scans back. Set a spending alert in Meshy, as with your AI key.

**Black Friday sign-up sale.** Accounts created between `SIGNUP_BONUS_STARTS` and `SIGNUP_BONUS_ENDS` get `SIGNUP_BONUS` scans once, on top of the monthly free ones. They go into the never-expiring balance, logged in `credit_events` as kind `bonus` with ref `signup-bonus:<user id>`. While the sale is on, a cream strip at the top of the app shows the deal and a countdown; it disappears by itself when the time runs out, and the server stops giving the bonus to accounts made after that. Run the updated `supabase/schema.sql` once to add `bs_add_bonus` (until you do, the bonus still works but is logged as kind `purchase`).

**Checking on users.** Supabase → **Table Editor**: `credits` shows each account's free and bought scans, and `credit_events` logs every grant, scan, refund and purchase. To give someone scans by hand, edit their `paid` number.

Without Stripe variables, accounts still work with the free monthly scans only, and the buy section is hidden. With accounts on, `ACCESS_CODE` is ignored.

## Optional settings (same Environment variables screen)

| Variable | Use |
|---|---|
| `ACCESS_CODE` | Anyone using the app must enter this code once per device. Good if you share the link. |
| `AI_PROVIDER` | `anthropic` (default), `openai` or `gemini`, matching your key. |
| `AI_MODEL` | A different model. Defaults: `claude-sonnet-5-5`, `gpt-5.5`, `gemini-3.6-flash`. |
| `DONATE_URL` | Your donation page (must start with `https://`), e.g. a PayPal, Ko-fi or Buy Me a Coffee link. It appears as a line at the bottom of the app. Leave it unset and the line is hidden. |

| `REPLY_CODE` | Your private code for the Reply Desk (below). Pick something only you know. Without it the Reply Desk stays locked. |

Redeploy after changing any variable.

## Reply Desk (owner only)

`your-site/reply.html` is a private helper for answering "what part is this?" posts on Reddit and forums. It's hidden from search engines and locked with `REPLY_CODE`.

1. Save the photo from the post, then drop or paste it in.
2. Pick where you're replying and paste what they asked (optional, makes the reply more specific).
3. Tap **Scan & write reply**. Build Spotter scans the photo, then writes a short reply that answers the post.
4. Not quite right? **Write another version**. Each version uses a different tone, opening, structure and link placement, and avoids the openings of your recent replies.
5. Check the three ticks (link once, says you built it, length), edit if needed, **Copy reply**, and post it yourself.

Every reply answers the question honestly (it says "looks like" when the scan isn't sure), includes your link once, and discloses that you built the tool. Keep posting by hand: automated posting breaks Reddit's and most forums' spam rules.

## Protect your bill

Everyone who uses the app spends from your key (credits cap how much each account can scan). Set a monthly spend limit in your AI provider's console (in Anthropic's console, look under Limits) so a shared link can't run up a surprise bill. Each scan typically costs a few cents or less.

## Run it on your computer (no deploy needed)

Test changes locally first; only upload to GitHub when they work.

1. Install **Node.js** (the LTS version from nodejs.org). Then, in a terminal: `npm install -g netlify-cli`
2. In the terminal, go into the `build-spotter-app` folder (`cd path/to/build-spotter-app`).
3. Copy `.env.example` to `.env` and put your API key in it. Leave the Supabase lines out to test without accounts.
   (Or, if you've run `netlify login` and `netlify link`, `netlify dev` uses the variables already saved on Netlify, and `.env` is optional.)
4. Run `netlify dev`. It opens http://localhost:8888 with the app and all the server functions, exactly as on Netlify.
5. Edit a file and reload the page. Changes to `public/` show up on reload; changes to `netlify/functions` are picked up automatically.
6. Stop it with Ctrl+C.

Notes: the first start can take a minute while it sets things up. To try it on your phone, open `http://YOUR-COMPUTER-IP:8888` on the same Wi-Fi. Sign-in emails from Supabase link back to your live site, so test sign-up on the live site and everything else locally. Don't upload `.env`; `.gitignore` keeps it out of GitHub.

## Updating the app later

Upload the changed files to the same GitHub repo (same "upload files" button). Netlify redeploys automatically.

## If something goes wrong

- **App asks for an API key:** the function isn't running. Check that the `netlify` folder and `netlify.toml` made it into GitHub at the top level, not inside another folder.
- **"The app's server isn't set up yet":** `AI_API_KEY` is missing or wrong, or you didn't redeploy after adding it.
- **"Sign in" doesn't come back to the app, or reset links go to localhost:** set the Site URL and Redirect URLs in Supabase (step A3).
- **Paid but no scans:** check Stripe → Webhooks → your endpoint for failed deliveries, and that `STRIPE_WEBHOOK_SECRET` matches that endpoint. Scans are also added when the buyer returns to the app.
- **Errors after a scan:** Netlify → Logs → Functions → `analyze` shows the AI service's error message.
