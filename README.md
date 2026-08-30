# Guardman RTSP Backend

Converts an institution's RTSP camera feed into an HLS stream that the
Guardman web app (or any browser) can play, so live AI detection (phone,
vape, cigarette, fight/weapon) can run on real CCTV footage.

## Why this exists
Browsers cannot play `rtsp://` links directly. This small server:
1. Receives an RTSP URL from the Guardman "Add Camera" screen.
2. Runs ffmpeg (via the ffmpeg-static npm package, no system install needed) to continuously convert that feed into HLS (.m3u8 + .ts segments).
3. Serves those segments over HTTPS so the frontend can load them into a normal <video> tag using hls.js.

## Deploying to Render (free tier)

1. This repo is ready to deploy as-is — no Docker needed.
2. Go to **render.com** → **New +** → **Web Service**.
3. Connect your GitHub account and select this repo.
4. Runtime: **Node**. Build Command: `npm install`. Start Command: `npm start`.
5. Instance type: **Free**.
6. Click **Create Web Service**. First deploy takes a few minutes.
7. Once live, Render gives you a URL like `https://guardman-backend.onrender.com` — this is your backend URL, used in the Guardman app.

## Free tier limitation to know
Render's free web services spin down after ~15 minutes of no traffic and take
~30-60 seconds to wake back up on the next request. For a school running
cameras during fixed hours, the first camera connection each day may be
slow to start — this is expected and not a bug.

## Setting up the Telegram approval bot (free)

1. Open Telegram, message **@BotFather**, send `/newbot`, follow the prompts. You'll get a Bot Token like `123456:ABC-DEF...`.
2. Message your new bot anything (e.g. "hi") so it knows who you are.
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser — find `"chat":{"id": ...}` in the response. That number is your Admin Chat ID.
4. In Render, go to your service → **Environment** → add:
   - `TELEGRAM_BOT_TOKEN` = your bot token
   - `ADMIN_CHAT_ID` = your chat id
   - `ROBOFLOW_API_KEY` = your Roboflow private API key

   None of these ever appear in the frontend code or GitHub repo — Render keeps them server-side only.

5. After deploying, register the webhook once (replace both placeholders):
