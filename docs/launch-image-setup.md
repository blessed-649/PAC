# Launch image generation setup

The launch form has an optional "Generate coin image with NEAR AI" choice.
It is off by default; launching without it works exactly as before. When a
user opts in, the browser calls `POST /api/generate-image` (serverless
function `api/generate-image.js`), which generates an image with NEAR AI
Cloud and hosts it, then fills the image URL into the launch form.

## Environment variables (Vercel)

Set these in the Vercel project dashboard: Project Settings → Environment
Variables, environment **Production**, then redeploy. The values are never
committed to the repo and never appear in the browser.

| Variable | Required | Where it comes from |
|---|---|---|
| `NEAR_AI_API_KEY` | Yes | The PAC NEAR AI key, the same one the AI meme judge uses. In the NEAR AI Cloud dashboard (cloud.near.ai → API Keys) it is the key for the PAC account. It draws from the same $10 credit pool claimed on otoyo4real.near. |
| `PINATA_JWT` | Yes | A Pinata API key (pinata.cloud → API Keys → New API Key). Generated images are pinned to IPFS and the URL is an IPFS gateway URL (`https://gateway.pinata.cloud/ipfs/<CID>`). Pinata has a free tier that covers this use. |

## Cost

$0.012 per generated image, paid from the NEAR AI credit pool. The launch
form shows the cost next to the option, and generated images are labelled
AI generated in the form.

## How it works

1. The user ticks the option, edits the prompt if they want (default is
   built from the coin name and description), and clicks Generate image.
2. The function calls NEAR AI Cloud `POST /v1/images/generations` with
   model `black-forest-labs/FLUX.2-klein-4B`, size 1024x1024, and returns
   a base64 JPEG.
3. The function hosts the image on IPFS through Pinata and returns a real
   `https://` gateway URL.
4. The launch form fills the image URL input with it and shows a preview.
   The coin launches with it through the existing `launch_coin` image_url
   path, and the creator can replace it later with `set_coin_image`.

## Failure behaviour

- `NEAR_AI_API_KEY` or `PINATA_JWT` missing: the function returns a clear
  error naming the missing variable; the user can still launch without an
  image or paste an image URL.
- Generation or hosting fails: the form shows the error and the launch
  stays possible without an image or with a pasted URL. The launch is
  never blocked by image generation.
- The browser never holds the NEAR AI key, and the key never appears in
  any response, log, or committed file.

## Model

`black-forest-labs/FLUX.2-klein-4B` is the only image output model in the
NEAR AI Cloud catalog. Generation was verified live (1024x1024 JPEG,
about 4 seconds per image).
