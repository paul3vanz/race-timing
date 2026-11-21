# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Live sync (Supabase)

The app works fully offline by default. To push results to Supabase for a
live results URL, copy `.env.example` to `.env`, fill in your Supabase URL
and anon key, and restart `expo start`. See [supabase/README.md](supabase/README.md)
for schema/setup details. Sync status and a manual "Sync Now" button are on
the Settings tab.

## Race day: several devices

Every device writes to its own local SQLite, so nothing needs a connection
during the race. Phones join the same race with its 6-character code (Races
tab, Join Race) and sync through Supabase whenever they have signal. Results
merges the raw rows from every device, so any phone or the web build can be
used to watch and correct the results.

A typical set-up:

| Who | Where | Screen | What it records |
| --- | --- | --- | --- |
| Two timers | Finish line | **Timer** | A tap per finisher, no bibs. Taps within about 1.5s on different timers count as one finisher, so one missing a click or tapping twice is caught by the other. |
| Backup bib recorder | Finish line | **Bib**, mode **finish line** | The bibs they can catch, timed as typed. A partial list, used to cross-check the timers and to recover a runner the funnel missed. Not published as results. |
| Funnel bib recorder | End of the funnel | **Bib**, mode **funnel** (default) | The complete list. With the timers' taps on the phone (it has signal) each bib is matched to the next tap in order; offline, bibs are timed as typed and matched to taps afterwards on Results. A few seconds' lag is expected and handled. |
| Anyone | Anywhere | **Results** | Fix a mistyped bib, discard a stray tap, add a missed one, or re-match bibs to taps in order. Edits sync to every device. |

Switch a Bib phone between **funnel** and **finish line** with the mode button
at the top of its screen. After the race, sync the phones, open Results and tap
**Confirm all confident matches** so the corrected times are what gets
published. Use **Stop** on the Races list to close a race and **Prizes** on the
Results screen for the prize-giving report.

### What the live results page sees

The public (`anon`) role can only read published results from `finishes`: not
removed entries, not folded-in duplicates, and not finish-line entries (see
`supabase/migrations/20261121100000_finish_source_and_published_results.sql`).
The website needs no change for this to apply. The app itself reads as a signed-in
anonymous session so it still sees every raw row.

### Applying migrations

The `supabase` CLI now defaults to a local Docker database; target the hosted
project explicitly:

```bash
npx supabase db push --remote
```

Apply new migrations before installing a build that needs them, otherwise the
remote rejects the new columns until it has them.

### Volume buttons as the Timer tap

On Android the volume buttons act as tap buttons on the Timer screen while the
race is running (no volume slider, no change to media volume). This uses a
small local native module in `modules/volume-keys`, so it needs a development
or production build (`npx expo run:android` or an EAS build). It is not
available in Expo Go or on the web, where the screen tap still works as before.

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
