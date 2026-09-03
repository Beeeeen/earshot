/**
 * Renders one spotlight callout to a transparent PNG.
 *
 * The b-roll shot by `npm run record` burns its callouts in from the page
 * itself, so footage shot outside the app — a real ChatGPT session — would
 * otherwise be the only part of the cut with nothing labelled, exactly where
 * the most is happening. This re-renders the same markup and the same CSS in a
 * headless window and hands back a PNG for ffmpeg to lay over the clip, so the
 * two sources are indistinguishable in the finished video.
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** record.mjs styles the callout for a 1600px-wide viewport. */
const DESIGN_WIDTH = 1600;

export async function renderCallout(headline, sub, outPath, frameWidth = 2400) {
  const k = frameWidth / DESIGN_WIDTH;
  const px = (n) => `${(n * k).toFixed(1)}px`;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--force-device-scale-factor=1'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: frameWidth, height: 600 });
    await page.setContent(
      `<body style="margin:0;background:transparent">
         <div id="pad" style="display:inline-block;padding:${px(56)}">
           <div style="display:inline-block;padding:${px(20)} ${px(28)};border-radius:${px(14)};
                       background:#14181a;color:#f7f6f2;
                       box-shadow:0 ${px(18)} ${px(50)} -${px(18)} rgba(0,0,0,.55);
                       font:600 ${px(15)}/1.4 ui-sans-serif,system-ui,'Segoe UI',sans-serif;
                       max-width:${px(640)}">
             <div style="font-size:${px(44)};font-weight:700;letter-spacing:-.02em;line-height:1.05">${headline}</div>
             ${sub ? `<div style="font-size:${px(17)};font-weight:500;color:#9fb3a8;margin-top:${px(9)}">${sub}</div>` : ''}
           </div>
         </div>
       </body>`,
      { waitUntil: 'load' },
    );
    // The 56px wrapper matches record.mjs left/bottom offsets, so the PNG can be
    // overlaid flush with the frame corner and still land in the same place.
    await page.$('#pad').then((el) => el.screenshot({ path: outPath, omitBackground: true }));
  } finally {
    await browser.close();
  }
  return outPath;
}
