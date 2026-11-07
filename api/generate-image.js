// POST /api/generate-image — generate a coin image with NEAR AI and host it.
//
// Optional launch image for PAC. The browser never holds the NEAR AI key:
// this serverless function reads it from the environment and calls NEAR AI
// Cloud server side. See docs/launch-image-setup.md for the env vars.
//
// Request:  POST, JSON body {"prompt": "<1 to 500 chars>"}.
// Response: 200 {"image_url": "https://gateway.pinata.cloud/ipfs/<CID>",
//                "host": "ipfs", "cost_usd": 0.012, "ai_generated": true}
// Errors:   400 bad prompt, 500 a required env var is not configured,
//           502 NEAR AI or hosting failed. Bodies are {"error": "..."} and
//           never contain key material.
//
// Hosting is Pinata IPFS, so the image URL is content addressed and stays
// reachable as long as the pin exists. Generation is fast (measured ~4s
// for FLUX.2-klein-4B), well inside the default serverless timeout.

const NEAR_AI_URL = 'https://cloud-api.near.ai/v1/images/generations';
const IMAGE_MODEL = 'black-forest-labs/FLUX.2-klein-4B';
const IMAGE_COST_USD = 0.012;
const PINATA_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';

function randomHex(n) {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}

// Build a multipart/form-data body without dependencies.
// fields: [{name, value}] text, or [{name, filename, contentType, data: Buffer}].
function multipart(fields) {
  const boundary = '----pac' + randomHex(24);
  const parts = [];
  for (const f of fields) {
    if (f.data) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`,
      ));
      parts.push(f.data);
      parts.push(Buffer.from('\r\n'));
    } else {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`,
      ));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(new Error('Request body was not valid JSON.'));
      }
    });
    req.on('error', () => reject(new Error('Could not read the request body.')));
  });
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function generateImage(prompt, apiKey) {
  const res = await fetchWithTimeout(NEAR_AI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
    }),
  }, 120000);
  if (!res.ok) {
    throw new Error(`NEAR AI image generation failed (${res.status}).`);
  }
  const data = await res.json();
  const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
  if (!b64 || typeof b64 !== 'string') {
    throw new Error('NEAR AI returned no image.');
  }
  const buf = Buffer.from(b64, 'base64');
  // FLUX returns a JPEG; refuse anything that is not one.
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    throw new Error('NEAR AI returned an image in an unexpected format.');
  }
  return buf;
}

async function pinToPinata(imageBuf, pinataJwt) {
  const { boundary, body } = multipart([
    { name: 'file', filename: 'pac-coin.jpg', contentType: 'image/jpeg', data: imageBuf },
    { name: 'pinataMetadata', value: JSON.stringify({ name: 'pac-coin.jpg' }) },
  ]);
  const res = await fetchWithTimeout(PINATA_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pinataJwt}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  }, 60000);
  if (!res.ok) {
    throw new Error(`IPFS pinning failed (${res.status}).`);
  }
  const data = await res.json();
  if (!data || !data.IpfsHash) {
    throw new Error('IPFS pinning returned no content id.');
  }
  return PINATA_GATEWAY + data.IpfsHash;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'Use POST with a JSON prompt.' });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim().replace(/[\u0000-\u001f]/g, ' ') : '';
    if (!prompt || prompt.length > 500) {
      return send(res, 400, { error: 'Prompt is required and must be at most 500 characters.' });
    }
    const apiKey = process.env.NEAR_AI_API_KEY;
    if (!apiKey) {
      return send(res, 500, { error: 'Image generation is not configured yet (NEAR_AI_API_KEY is missing). You can still launch without an image or paste an image URL.' });
    }
    const pinataJwt = process.env.PINATA_JWT;
    if (!pinataJwt) {
      return send(res, 500, { error: 'Image hosting is not configured yet (PINATA_JWT is missing). You can still launch without an image or paste an image URL.' });
    }
    let imageBuf;
    try {
      imageBuf = await generateImage(prompt, apiKey);
    } catch (e) {
      return send(res, 502, { error: e.message });
    }
    let imageUrl;
    try {
      imageUrl = await pinToPinata(imageBuf, pinataJwt);
    } catch (e) {
      return send(res, 502, { error: e.message + ' You can still launch without an image or paste an image URL.' });
    }
    if (!/^https:\/\//.test(imageUrl) || imageUrl.length > 500) {
      return send(res, 502, { error: 'Hosting returned an unusable URL. You can still launch without an image or paste an image URL.' });
    }
    return send(res, 200, { image_url: imageUrl, host: 'ipfs', cost_usd: IMAGE_COST_USD, ai_generated: true });
  } catch (e) {
    return send(res, 500, { error: 'Image generation failed. You can still launch without an image or paste an image URL.' });
  }
};
