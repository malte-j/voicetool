# Project summary

`voice` is a browser-based singing practice app built with TypeScript and Vite.
It uses the microphone and a SwiftF0 ONNX model for live pitch detection, displays
notes on a piano-roll trail and keyboard, and includes target-note exercises. Each
listening session is recorded automatically and can be reviewed with synchronized
audio, a full pitch trail, and a scrubbable playhead.

# Development

The user needs a running development server to see and review the app. When making
user-visible changes, start `npm run dev` and leave the server running so the app is
available for preview.

# Deployment

The app is deployed to Cloudflare Workers at `https://voice.malte.ws`.

1. Build the production site:
   ```sh
   npm run build
   ```
2. Deploy:
   ```sh
   wrangler deploy
   ```
3. Open `https://voice.malte.ws` and confirm the pitch model reaches “Start listening.”

Do not run `wrangler deploy --dry-run` for routine deployments. Use it only when
Worker configuration or bindings have changed, or when troubleshooting a deployment.
Do not run `wrangler whoami` before routine deployments. Use it only after a deploy
fails with an error that may be related to Cloudflare authentication.

Deployment settings, including the custom domain and `dist` asset directory, live in
`wrangler.jsonc`.
