import { chromium } from '@playwright/test';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const reports = process.env.TRAINING_REPORT_DIR || '/workspace/reports/treinamento-central-financeira';
const name = 'Treinamento_Central_Financeira_Completo';
const document = await readFile(path.join(reports, `${name}.html`));
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(document);
  else res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'pt-BR' });
  const external = [], errors = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    external.push(url.origin); return route.abort();
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  const diagnostics = await page.evaluate(() => ({ chapters: document.querySelectorAll('.chapter').length, figures: document.querySelectorAll('.screen-page').length,
    broken_images: Array.from(document.images).filter(image => !image.complete || !image.naturalWidth).length,
    internal_links_broken: Array.from(document.querySelectorAll('a[href^="#"]')).filter(a => !document.getElementById(a.hash.slice(1))).map(a => a.hash) }));
  if (errors.length || external.length || diagnostics.broken_images || diagnostics.internal_links_broken.length) throw new Error(JSON.stringify({ errors, external, diagnostics }));
  await page.getByLabel('Buscar área, botão ou rotina').fill('próxima ação');
  const filtered = await page.locator('.chapter:visible').count();
  if (filtered < 1 || filtered >= diagnostics.chapters) throw new Error('Training search did not filter chapters');
  await page.getByLabel('Buscar área, botão ou rotina').fill('');
  await page.screenshot({ path: path.join(reports, 'previa-capa.png'), fullPage: false });
  await page.locator('#sumario').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(reports, 'previa-sumario.png'), fullPage: false });
  await page.pdf({ path: path.join(reports, `${name}.pdf`), preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true,
    headerTemplate: '<span></span>', footerTemplate: '<div style="font-family:Arial,sans-serif;font-size:8px;width:100%;padding:0 35px;color:#61766d;display:flex;justify-content:space-between"><span>Central Financeira · Treinamento · Dados de demonstração</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>' });
  await copyFile(path.join(reports, `${name}.pdf`), path.join(root, 'public/treinamento', `${name}.pdf`));
  await writeFile(path.join(reports, 'verificacao-documento.json'), JSON.stringify({ ...diagnostics, search_matches: filtered, external_requests: external, browser_errors: errors }, null, 2));
  console.log(JSON.stringify({ ...diagnostics, search_matches: filtered, pdf: path.join(reports, `${name}.pdf`) }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
