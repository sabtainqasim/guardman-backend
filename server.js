/**
 * Guardman RTSP-to-HLS Backend
 * ----------------------------
 * Browsers cannot play RTSP directly. This server takes an institution's
 * RTSP camera link, spins up an ffmpeg process that converts it into HLS
 * (HTTP Live Streaming) segments, and serves those segments over plain
 * HTTP/HTTPS so the Guardman frontend can play them in a normal <video> tag
 * (via hls.js) and run AI detection on the frames exactly like a webcam.
 *
 * Each active camera gets its own ffmpeg process + its own folder of
 * .m3u8/.ts files under /tmp/streams/<streamId>/.
 */

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const STREAMS_DIR = path.join('/tmp', 'streams');
if (!fs.existsSync(STREAMS_DIR)) fs.mkdirSync(STREAMS_DIR, { recursive: true });

const activeStreams = {};

app.use('/streams', express.static(STREAMS_DIR));

app.post('/api/streams', (req, res) => {
  const { rtspUrl, institutionId, cameraName } = req.body;

  if (!rtspUrl || !rtspUrl.startsWith('rtsp://')) {
    return res.status(400).json({ error: 'A valid rtsp:// URL is required.' });
  }

  const streamId = uuidv4();
  const outDir = path.join(STREAMS_DIR, streamId);
  fs.mkdirSync(outDir, { recursive: true });
  const playlistPath = path.join(outDir, 'index.m3u8');

  const ffmpegArgs = [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-c:a', 'aac',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '4',
    '-hls_flags', 'delete_segments+omit_endlist',
    playlistPath
  ];

  const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

  ffmpegProcess.stderr.on('data', (data) => {});

  ffmpegProcess.on('exit', (code) => {
    console.log(`Stream ${streamId} ffmpeg process exited with code ${code}`);
    delete activeStreams[streamId];
  });

  ffmpegProcess.on('error', (err) => {
    console.error(`Stream ${streamId} failed to start:`, err.message);
    delete activeStreams[streamId];
  });

  activeStreams[streamId] = {
    process: ffmpegProcess,
    rtspUrl,
    institutionId: institutionId || 'unknown',
    cameraName: cameraName || 'Unnamed Camera',
    startedAt: new Date().toISOString()
  };

  setTimeout(() => {
    res.json({
      streamId,
      hlsUrl: `/streams/${streamId}/index.m3u8`,
      cameraName: activeStreams[streamId]?.cameraName
    });
  }, 3000);
});

app.delete('/api/streams/:id', (req, res) => {
  const { id } = req.params;
  const entry = activeStreams[id];
  if (!entry) return res.status(404).json({ error: 'Stream not found or already stopped.' });

  entry.process.kill('SIGKILL');
  delete activeStreams[id];

  const outDir = path.join(STREAMS_DIR, id);
  fs.rm(outDir, { recursive: true, force: true }, () => {});

  res.json({ stopped: true });
});

app.get('/api/streams', (req, res) => {
  const list = Object.entries(activeStreams).map(([id, s]) => ({
    id,
    cameraName: s.cameraName,
    institutionId: s.institutionId,
    startedAt: s.startedAt
  }));
  res.json(list);
});

const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_MODEL_ENDPOINTS = {
  'vape-cigarette': 'https://detect.roboflow.com/sabtain-butt/cigarette-vape-detection-gsw55/1',
  'violence-weapon': 'https://detect.roboflow.com/sabtain-butt/violence-weapon-detection-meoco/1'
};

app.post('/api/detect/:modelKey', async (req, res) => {
  const endpoint = ROBOFLOW_MODEL_ENDPOINTS[req.params.modelKey];
  if (!endpoint) return res.status(400).json({ error: 'Unknown model key.' });
  if (!ROBOFLOW_API_KEY) return res.status(500).json({ error: 'Server is missing ROBOFLOW_API_KEY.' });

  const { image, confidence } = req.body;
  if (!image) return res.status(400).json({ error: 'image (base64) is required.' });

  try {
    const roboflowRes = await fetch(`${endpoint}?api_key=${ROBOFLOW_API_KEY}&confidence=${confidence || 45}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: image
    });
    const data = await roboflowRes.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Roboflow request failed', detail: err.message });
  }
});

const allAlerts = [];

app.post('/api/alerts', async (req, res) => {
  const { institutionName, alertType, confidence, cameraName, image } = req.body;
  if (!institutionName || !alertType) {
    return res.status(400).json({ error: 'institutionName and alertType are required.' });
  }

  const alert = {
    id: uuidv4(),
    institutionName,
    alertType,
    confidence: confidence || null,
    cameraName: cameraName || 'Unknown Camera',
    imageBase64: image || null,
    timestamp: new Date().toISOString()
  };
  allAlerts.unshift(alert);
  if (allAlerts.length > 500) allAlerts.pop();

  if (TELEGRAM_API && ADMIN_CHAT_ID) {
    const caption =
      `🚨 *${alertType}*\n` +
      `Institution: ${institutionName}\n` +
      `Camera: ${alert.cameraName}\n` +
      (confidence ? `Confidence: ${Math.round(confidence * 100)}%\n` : '') +
      `Time: ${new Date(alert.timestamp).toLocaleString()}`;

    if (image) {
      await fetch(`${TELEGRAM_API}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, photo: `data:image/jpeg;base64,${image}`, caption, parse_mode: 'Markdown' })
      }).catch(() => {
        sendTelegramMessage(ADMIN_CHAT_ID, caption);
      });
    } else {
      await sendTelegramMessage(ADMIN_CHAT_ID, caption);
    }
  }

  res.json({ stored: true, id: alert.id });
});

app.get('/api/alerts', (req, res) => {
  res.json(allAlerts.slice(0, 100));
});

app.get('/health', (req, res) => res.json({ status: 'ok', activeStreams: Object.keys(activeStreams).length }));

const institutions = {};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const TELEGRAM_API = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : null;

function generateCode(prefix){
  return prefix.slice(0, 4).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
}

async function sendTelegramMessage(chatId, text, replyMarkup){
  if (!TELEGRAM_API) { console.log('[Telegram not configured] Would send:', text); return; }
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup
    })
  });
}

async function editTelegramMessage(chatId, messageId, text){
  if (!TELEGRAM_API) return;
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' })
  });
}

app.post('/api/institutions', async (req, res) => {
  const { name, email, contact, phone } = req.body;
  if (!name || !email || !contact) {
    return res.status(400).json({ error: 'name, email and contact are required.' });
  }

  const id = uuidv4();
  institutions[id] = { id, name, email, contact, phone, status: 'pending', codes: null, createdAt: new Date().toISOString() };

  const text =
    `🏫 *New Institution Request*\n\n` +
    `*Name:* ${name}\n*Contact:* ${contact}\n*Email:* ${email}\n*Phone:* ${phone || '—'}\n\n` +
    `Approve to auto-generate staff access codes.`;

  const replyMarkup = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve_${id}` },
      { text: '✕ Decline', callback_data: `decline_${id}` }
    ]]
  };

  if (ADMIN_CHAT_ID) await sendTelegramMessage(ADMIN_CHAT_ID, text, replyMarkup);

  res.json({ id, status: 'pending' });
});

app.get('/api/institutions/:id/status', (req, res) => {
  const inst = institutions[req.params.id];
  if (!inst) return res.status(404).json({ error: 'Not found' });
  res.json({ status: inst.status, codes: inst.status === 'approved' ? inst.codes : undefined });
});

app.post('/telegram/webhook', async (req, res) => {
  const callback = req.body.callback_query;
  if (!callback) return res.sendStatus(200);

  const [action, id] = callback.data.split('_');
  const inst = institutions[id];
  if (!inst) return res.sendStatus(200);

  if (action === 'approve') {
    inst.status = 'approved';
    inst.codes = {
      Principal: generateCode('PRIN'),
      'Vice Principal': generateCode('VP'),
      'Discipline Incharge': generateCode('DISC')
    };
    await editTelegramMessage(
      callback.message.chat.id,
      callback.message.message_id,
      `✅ *Approved:* ${inst.name}\n\nCodes issued:\nPrincipal: \`${inst.codes.Principal}\`\nVice Principal: \`${inst.codes['Vice Principal']}\`\nDiscipline Incharge: \`${inst.codes['Discipline Incharge']}\`\n\nShare these privately with ${inst.contact}.`
    );
  } else if (action === 'decline') {
    inst.status = 'declined';
    await editTelegramMessage(
      callback.message.chat.id,
      callback.message.message_id,
      `✕ *Declined:* ${inst.name}`
    );
  }

  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callback.id })
  });

  res.sendStatus(200);
});

const PORT = process.env.PORT || 9001;
app.listen(PORT, () => {
  console.log(`Guardman RTSP backend listening on port ${PORT}`);
});
