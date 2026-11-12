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

Typical set-up is two phones on **Timer**, one on **Bib**, and optionally a
third watching **Results**. Join the other phones with the race's 6-character
code (Races tab, Join Race). Every device writes to its own local SQLite and
syncs through Supabase; the Bib queue and the Results screen both merge the
taps from every Timer, so taps within about 1.5s on different Timers count as
one finisher. Results can be corrected from any device (tap a row to fix a
bib, discard a stray tap, or remove an entry) and the change syncs to the rest.
Use **Stop** on the Races list to close a race, and **Prizes** on the Results
screen for the prize-giving report.

Apply `supabase/migrations/20261112100000_duplicate_bibs_and_voided_finishes.sql`
(`supabase db push`) before installing this version on the phones, otherwise
finish rows are rejected by the remote until it has the new column.

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
