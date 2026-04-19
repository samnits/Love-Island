# Our Love Calendar

A private couples app with instant updates:
- Two private accounts with Clerk email auth (login/signup)
- Connect partners using **Love Code** (Generate + Join)
- Anyone can click **I Miss You** once connected
- Partner gets real-time in-app notification (WebSocket)
- Partner also receives email with direct website link
- Reply with photo + cute note
- Entries save into calendar view and can export as Outlook `.ics`

## Tech Stack
- Node.js + Express
- SQLite
- WebSocket (`ws`)
- Nodemailer (email)
- Multer (photo upload)
- Clerk (`@clerk/express` + Clerk JS)
- Vanilla HTML/CSS/JS frontend

## Run Locally
1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure Clerk environment variables before starting server:
   - `CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
3. Optional: configure email in `.env` style environment variables:
   - `SMTP_HOST`
   - `SMTP_PORT` (587 or 465)
   - `SMTP_USER`
   - `SMTP_PASS`
   - `SMTP_FROM` (optional; defaults to `SMTP_USER`)
   - `APP_URL` (optional; defaults to `http://localhost:3000`)
4. Start app:
   ```bash
   npm start
   ```
5. Open:
   ```
   http://localhost:3000
   ```

## Clerk Setup
1. Create an app in Clerk dashboard.
2. Enable email sign-in/sign-up method you want:
   - Email + password, or
   - Email code, or
   - Email link.
3. Add local development URL in allowed origins/redirects (for example `http://localhost:3000`).
4. Copy publishable key and secret key into your environment variables.
5. Restart server after key changes.

## Workflow
1. Create two accounts using Clerk (one for each partner).
2. One user generates a Love Code.
3. Other user joins using that Love Code.
4. Either user clicks **I Miss You**.
5. Other partner receives instant in-app notification and email link.
6. Partner uploads photo + cute note and selects date.
7. Memory appears in calendar and can be exported as `.ics`.

## Notes
- Uploaded files are stored in `uploads/`.
- Data is stored in `data/couples.db`.
- Without SMTP configuration, in-app notifications still work, but email is skipped.
