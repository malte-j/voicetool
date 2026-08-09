# Deployment

The app is deployed to Cloudflare Workers at `https://voice.malte.ws`.

1. Verify Cloudflare authentication:
   ```sh
   wrangler whoami
   ```
2. Build the production site:
   ```sh
   npm run build
   ```
3. Validate the deployment without publishing:
   ```sh
   wrangler deploy --dry-run
   ```
4. Deploy:
   ```sh
   wrangler deploy
   ```
5. Open `https://voice.malte.ws` and confirm the pitch model reaches “Start listening.”

Deployment settings, including the custom domain and `dist` asset directory, live in
`wrangler.jsonc`.
