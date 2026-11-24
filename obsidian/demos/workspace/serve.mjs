import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { renderDocument } from '../../../editor/render-document.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const theme = fileURLToPath(new URL('../../../packages/peerpedia-theme/dist/', import.meta.url));
const port = Number(process.env.PEERPEDIA_DEMO_PORT || 43127);
const mime = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'};
/** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @returns {Promise<void>} */
async function handle(request, response) {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (request.method === 'POST' && url.pathname === '/render') {
      if (request.headers.origin !== `http://127.0.0.1:${port}`) { response.writeHead(403).end(); return; }
      let body = '';
      for await (const part of request) { body += part; if (body.length > 256000) throw new Error('Demo document is too large.'); }
      const input = JSON.parse(body);
      const result = await renderDocument({pages:input.pages, diagrams:false});
      response.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(result)); return;
    }
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const isTheme = url.pathname.startsWith('/theme/');
    const base = isTheme ? theme : root;
    const path = resolve(base, '.' + (isTheme ? url.pathname.slice(6) : url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(base) || (!isTheme && !['index.html','demo.js','demo.css'].includes(path.slice(base.length)))) { response.writeHead(404).end(); return; }
    const content = await readFile(path);
    response.writeHead(200, {'Content-Type':mime[extname(path)] || 'application/octet-stream','Cache-Control':'no-store'}).end(content);
  } catch (error) { response.writeHead(400, {'Content-Type':'application/json'}).end(JSON.stringify({error:error instanceof Error ? error.message : 'Preview unavailable'})); }
}
createServer(handle).listen(port, '127.0.0.1', /** @returns {void} */ () => { console.log(`Peerpedia demos: http://127.0.0.1:${port}`); });
