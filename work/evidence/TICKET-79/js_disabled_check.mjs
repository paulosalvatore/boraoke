import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://127.0.0.1:3196';
const ROOM = 'some-venue';
const results = [];

async function check(label, path, cookieVal) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ javaScriptEnabled: false });
  if (cookieVal) {
    await context.addCookies([{
      name: 'NEXT_LOCALE',
      value: cookieVal,
      domain: '127.0.0.1',
      path: '/',
    }]);
  }
  const page = await context.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
  const lang = await page.getAttribute('html', 'lang');
  const bodyText = await page.content();
  const hasScanEn = bodyText.includes('Scan to join the queue');
  const hasEscaneiaPt = bodyText.includes('Escaneia para entrar na fila');
  const hasEscaneaEs = bodyText.includes('Escanea para entrar a la fila');
  results.push({ label, path, cookieVal, lang, hasScanEn, hasEscaneiaPt, hasEscaneaEs });
  await browser.close();
}

await check('G_tv_es_cookie_jsdisabled', `/${ROOM}/tv`, 'es');
await check('G_tv_none_jsdisabled', `/${ROOM}/tv`, null);

fs.writeFileSync('js_disabled_results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
