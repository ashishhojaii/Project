# SW Living Solutions

## Run locally

Install dependencies once:

```powershell
npm install
```

Start the website and enquiry API:

```powershell
npm start
```

Open `http://localhost:3000`. Do not open `index.html` directly when testing the enquiry form; it needs the API server.

The server saves valid enquiries to `.private/enquiries.sqlite`. Keep the `.private` directory private and backed up. It is excluded from Git.

Set the `PORT` environment variable to change the HTTP port. Set `DATABASE_PATH` to store the SQLite database outside this project directory in production.

## Owner dashboard

The owner can review, search, refresh and contact enquiry senders at `http://localhost:3000/admin`.

Before first use, create a private `.env` file in the project root. In PowerShell:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Open `.env` and set:

- `ADMIN_PASSWORD` to a private password of at least 12 characters.
- `SESSION_SECRET` to the random value printed by the command above.

Restart the server, then sign in at `/admin`. Never share `.env`, commit it, or use the example placeholders as real credentials. Sign-in is rate-limited and the session expires after eight hours.

For deployment, set `ADMIN_PASSWORD` and `SESSION_SECRET` in the host's private environment-variable settings, not in source code. Use HTTPS and attach persistent storage for the SQLite file; configure `DATABASE_PATH` to a file on that storage.