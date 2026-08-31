# Horizon agency prototype

Run the local product server with:

```bash
npm start
```

Then open `http://localhost:3000`.

The local server persists talent applications, hiring briefs, and simulated payment requests in `data.json`. It is intentionally a local prototype: it does not authenticate users, send messages, connect wallets, or broadcast transactions.

## Supabase setup

1. Create a Supabase project.
2. Run [supabase/schema.sql](supabase/schema.sql) in its SQL editor.
3. Copy `.env.example` to `.env` and add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
4. Restart the server.

When those environment variables exist, the server writes form submissions and payment requests to Supabase instead of `data.json`. Never place the service-role key in a browser file or commit it to source control.
