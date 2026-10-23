# dE3p als echte iPhone-app

Dit is de gsm-app van www.de3p.be als echte app, met één extra: **Apple Watch**.
dE3p leest dan je slaap, HRV, rustpols, stappen, VO2max en gewicht uit Apple Gezondheid,
ook wat Garmin Connect, Oura, Whoop, Withings of Huawei Health daarin zetten. Samen met
Strava rechtstreeks op de gsm werkt alles **zonder computer**.

- Schermen: dezelfde als het programma (`app/`), met `web/bridge.js` als motor.
- Apple Gezondheid: `web/health.js` (plugin `@capgo/capacitor-health`).
- Strava: zoals op www.de3p.be (eigen Strava-sleutel), in een venster in de app.
- iOS-project: `ios/App` (Swift Package Manager, geen CocoaPods nodig).

## Eén keer klaarzetten op de Mac

1. Installeer **Xcode** (App Store) en open het één keer (accepteer de voorwaarden).
2. Installeer **Node.js LTS** van https://nodejs.org.
3. Haal de code op (privé-repo op GitHub, bv. met GitHub Desktop):
   `git clone https://github.com/dE3p-code/strava-automation.git`
4. In Terminal:

   ```
   cd strava-automation/mobile
   npm install
   npm run sync
   npx cap open ios
   ```

   `npm run sync` bouwt de app-bestanden (`www`) uit `app/` en `web/` en zet ze in het iOS-project.

## Op je iPhone zetten

1. In Xcode: klik links op **App** → tab **Signing & Capabilities**.
2. Bij **Team**: kies je Apple ID (Xcode → Settings → Accounts → + om je Apple ID toe te voegen).
3. Controleer dat **HealthKit** in de lijst staat (komt uit `App/App.entitlements`). Staat het er niet:
   **+ Capability** → **HealthKit**.
4. Is `be.de3p.app` al bezet, maak de **Bundle Identifier** uniek, bv. `be.de3p.app.jens`.
5. Sluit je iPhone aan met de kabel, zet op de iPhone **Ontwikkelaarsmodus** aan
   (Instellingen → Privacy en beveiliging → Ontwikkelaarsmodus) en kies je iPhone bovenaan in Xcode.
6. Klik op **▶** (Run). De eerste keer: op de iPhone Instellingen → Algemeen → VPN en apparaatbeheer →
   je Apple ID vertrouwen.

Met een gratis Apple ID werkt de app 7 dagen; daarna opnieuw op ▶. Met het betaalde
**Apple Developer Program** (99 euro per jaar, https://developer.apple.com/programs/enroll/)
blijft hij staan en kan hij naar TestFlight en de App Store. Lukt HealthKit niet met de
gratis versie, dan heb je het betaalde programma nodig.

## In de app

1. Kies **Strava rechtstreeks** en volg de stappen. Bij je Strava-sleutel is het
   *Authorization Callback Domain*: `www.de3p.be`.
2. Tandwiel → **Koppelingen** → **Apple Watch** → **Geef toegang** → zet alles aan → **Sta toe**.
3. Gezondheid en het Overzicht tonen nu je Apple Watch-gegevens.

Apple meet HRV als SDNN; Garmin, Whoop en Oura als rMSSD. De trend in dE3p klopt, de
cijfers zijn niet te vergelijken met die van een ander horloge.

## Na een wijziging in app/ of web/

```
cd mobile
npm run sync
```

en in Xcode opnieuw ▶. (Op de Windows-pc: `..\.venv\Scripts\python.exe ..\web\build_web.py www --native`
en daarna `npx cap sync ios`.)

## Zonder Mac: Codemagic (bouwt de app in de cloud)

Codemagic (gratis tot 500 bouwminuten per maand) bouwt de app op een Mac in de cloud en zet hem op
TestFlight. Je hebt geen Mac nodig. Het recept staat in `codemagic.yaml` (map strava-automation).

Eén keer klaarzetten (±30 minuten, dit doe je zelf):

1. **Apple Developer Program** (99 euro per jaar): https://developer.apple.com/programs/enroll/
2. **App-ID** op https://developer.apple.com/account → Certificates, IDs & Profiles → Identifiers → **+**
   → App IDs → Bundle ID `be.de3p.app` → vink **HealthKit** aan → Register.
3. **App Store Connect** (https://appstoreconnect.apple.com) → Apps → **+** → Nieuwe app: naam `dE3p`,
   taal Nederlands, bundle ID `be.de3p.app`, SKU `de3p`.
4. **API-sleutel**: App Store Connect → Gebruikers en toegang → Integraties → App Store Connect API →
   **+** → naam `Codemagic`, rol **App Manager** → download het `.p8`-bestand (kan maar één keer).
5. **Codemagic**: https://codemagic.io → inloggen met GitHub → repo `strava-automation` toevoegen.
   Daarna Teams → Integrations → **Developer Portal** → Connect → naam **`dE3p`**, Issuer ID, Key ID
   en het `.p8`-bestand.
6. In Codemagic bij de app: **Start new build** → workflow **dE3p iPhone-app naar TestFlight**.
7. Op je iPhone: installeer **TestFlight** uit de App Store en open de uitnodiging. dE3p staat erop.

Daarna: elke nieuwe versie = in Codemagic op **Start new build**, en TestFlight werkt de app bij.

## Naar de App Store (later)

- Apple Developer Program nodig (zie hierboven).
- In App Store Connect: nieuwe app `dE3p`, bundle ID zoals in Xcode.
- Nodig: een privacybeleid op de site (bv. www.de3p.be/privacy), schermafbeeldingen, en een
  uitleg waarom dE3p Apple Gezondheid leest (staat al in `Info.plist`).
- Xcode: Product → Archive → Distribute App → App Store Connect. Eerst via TestFlight testen.

## Android (later)

Zelfde project: `npm install @capacitor/android` en `npx cap add android`. Health Connect leest
dan Samsung Health en andere Android-apps (de plugin kan dat al). Huawei Health zet niets in
Health Connect; op een iPhone komt Huawei Health wel mee via Apple Gezondheid.
