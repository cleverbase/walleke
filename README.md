**Overview**
- Landing page: `index.html` uses the same visual language as portal/wallet and links to both experiences (desktop portal, mobile wallet) plus PWA install instructions.
- Portal/wallet exchange data via short-lived QR sessions:
  - Add flow: `portal/index.html` → `portal/add.html` → `portal/add-result.html`.
  - Share flow: `portal/index.html` → `portal/share.html` → `portal/share-result.html`.
- Sessions are coordinated by `js/qrflow*.js` talking to a demo Firebase Realtime Database.

**How It Works**
- The portal opens a QR “presenter” element that exposes a session ID to the wallet.
- The wallet scans (or pastes) the session code and writes back metadata and a response.
- The portal polls the session until a response is present and then renders the outcome.
- The wallet stores cards in `localStorage`, renders them using a simple UI schema, and can seed example cards.

**Run Locally**
- Serve as static files (any HTTP server works):
  - Node: `npx serve .` or `npx http-server .`
  - Python: `python -m http.server 8080`
- Recommended tabs:
  - Portal: `portal/index.html`
  - Wallet: `mobile/index.html`
- Use the “Sessiecode” field on portal pages to copy/paste session IDs into the wallet when you aren’t scanning with a camera.
- Root entry (`index.html`) is optional but useful when demoing the portal/mobile split or the PWA instructions.

**Core Pages**
- `portal/index.html` – entry; links to Add and Share scenarios.
- `portal/add.html` – shows a QR to add a card; includes a live payload editor.
- `portal/add-result.html` – confirms the selected type was added.
- `portal/share.html` – shows a QR requesting a scenario; wires `data/use-scenarios.json` into the request.
- `portal/share-result.html` – renders the result of a share; title/subtitle and details depend on the scenario and card type.
- `mobile/index.html` – mock wallet UI (add/share flows, local storage, seed prompt).

**Data and Configuration**
- Files in `data/` control s, examples, seeds, and use scenarios:

  - `data/card-types.json`
    - Per‑type UI schema used by portal and wallet to render details.
    - Keys:
      - `title` – human label for the type.
      - `order` – ordered list of payload keys.
      - `labels` – map of `payloadKey -> label`.
      - `format` – map of `payloadKey -> format` (`date`, `boolean`, `eur`).

  - `data/card-content.json`
    - Reusable example cards for the Add flow and seeding.
    - Keys per entry:
      - `visible` (default true) – controls listing on `portal/index.html`.
      - `type` – must exist in `card-types.json`.
      - `issuer` – displayed below the card title.
      - `payload` – object rendered using the type schema.
      - `issuedAt` / `expiresAt` (optional) – ISO string or epoch ms.

  - `data/cards-seed.json`
    - Optional seed list the wallet can import.
    - Contains named sets used by the wallet:
      - `pid` – PID only (default first-run seed).
      - `pid_inkomen` – PID + latest income statements.
      - `pid_memberships` – PID + NVM membership + KNB registration + NBA registration.
    - Entries can reference `card-content.json` via `{ "typeRef": "...", "contentRef": "..."] }` or provide inline payloads.

  - `data/use-scenarios.json`
    - Share flow scenarios driving `portal/share.html` and `portal/share-result.html`.
    - Common fields per scenario ID (uppercase recommended):
      - `visible` – hide from scenario list when false.
      - `title`, `subtitle`, `logo` – branding on `share.html`.
      - `request` – what to ask the wallet for:
        - `typeRef` (preferred) or `type` – matches a key from `card-types.json`.
        - `contentRef` (optional) – derive type from an entry in `card-content.json`.
      - Result header on `share-result.html`:
        - `resultTitle` | `resultTitleTemplate` – outer page title (`<h1>`).
        - `resultName` | `resultNameTemplate` – inner panel heading; if missing/empty, no inner title is shown.
        - `resultSubtitle` | `resultSubtitleTemplate` – inner subtitle; shown only when non‑empty.
        - `resultShowTitle`, `resultShowSubtitle` – extra switches to hide inner title/subtitle.
      - Content area:
        - `resultTemplate` – free text block (templated) above the details list.
        - `showDetails` – hide or show the detail rows (default true).

**Templating**
- Several fields accept templates with `{{ ... }}` placeholders.
- Context keys available in templates on `share-result.html`:
  - `payload` – attributes of the shared card, e.g. `{{payload.given_name}}`.
  - `shared` – raw response (includes `type`, `issuer`, etc.).
  - `scenario` – the active scenario configuration.
- Missing paths render as empty strings (no errors).

**Behavioral Details**
- Share result headers (`portal/share-result.html`):
  - If `resultName*` is empty the inner title is omitted.
  - The inner subtitle only renders when `resultSubtitle*` evaluates to non-empty.
  - The outer `<h1>` uses `resultTitle*` when provided.
- Details rendering (`portal/share-result.html`, wallet cards) follows `card-types.json`:
  - `date` → `dd-mm-yyyy`, `boolean` → `ja`/`nee`, `eur` → localized Euro.
  - Arrays join with comma; objects are JSON-stringified.
- Wallet behavior (`js/wallet-app.js`):
  - Cards live in `localStorage` and are rendered using the same UI schema.
  - Seeding logic:
    - On a fresh device only two buttons are shown: “Ja, vul met PID” and “Nee”.
    - After seeding once (or after triple-click reset) additional options appear for `PID + INKOMEN` and `PID + MEMBERSHIPS`.
    - Triple-click the “Wallet” title to clear the wallet, reset the prompt, and scroll to the seed card.
  - The seed prompt reads `data/cards-seed.json`/`data/card-content.json` for payloads.
  - Share flow returns `{ outcome: 'ok'|'not_found', type, issuer, payload }` to the portal.

**Session Transport**
- The helper in `js/qrflow.js` uses a Firebase Realtime Database (demo instance) as a simple rendezvous point.
- Database URL is configured inline in the portal and wallet scripts (search for `databaseURL` in the code).
- For production, host your own backend and secure transport; the current setup is purely for demo purposes.

**Extending The Demo**
- Add a new type: extend `data/card-types.json` (title/order/labels/format).
- Provide example content: add an entry to `data/card-content.json` (set `visible: true` to list it on the portal).
- Seed the wallet: extend `data/cards-seed.json` (`pid`, `pid_inkomen`, `pid_memberships` or add your own set names).
- Create a new share scenario: add to `data/use-scenarios.json` with `request.typeRef` and result configuration.

**Landing Page (`index.html`)**
- Mirrors the wallet/portal look & feel.
- Highlights the two flows, triple-tap seeding tips, and mobile PWA install steps.

**File Map**
- Portal
  - `portal/index.html`, `portal/add.html`, `portal/add-result.html`, `portal/share.html`, `portal/share-result.html`
- Wallet
  - `mobile/index.html`, `mobile/manifest.json`, `mobile/sw.js`, `js/wallet-app.js`
- Flow/infra
  - `js/qrflow.js`, `js/qrflow-auto.js`, `js/qrcode.min.js`, `js/html5-qrcode.min.js`
- Data
  - `data/card-types.json`, `data/card-content.json`, `data/cards-seed.json`, `data/use-scenarios.json`

**Notes**
- The demo is intentionally minimal and static; no build step is required.
- Styling is Tailwind‑based (`css/output.css`); visual customization can be added later.
