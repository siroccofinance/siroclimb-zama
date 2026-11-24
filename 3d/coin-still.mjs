// node 3d/coin-still.mjs assets/share/coin.png [size] [base]: the game's 3D coin alone, on a transparent background,
// for the server-rendered share card (assets/share/coin.png). Needs the dev server (node dev.mjs).
// The coin is drawn twice, on black and on white, and the alpha comes from the difference (no bloom, no halo).
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
const [out = '/tmp/coin-still.png', size = 1100, base = 'http://127.0.0.1:3043'] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const pg = await b.newPage(); pg.on('pageerror', e => console.log('ERR', e.message));
await pg.setViewport({ width: +size, height: +size, deviceScaleFactor: 1 });
// a blank same-origin page with the game's import map
await pg.setRequestInterception(true);
pg.on('request', r => r.url().endsWith('/__coin-still.html')
  ? r.respond({ contentType: 'text/html', body: `<!doctype html><html><body style="margin:0"><script type="importmap">${JSON.stringify({ imports: { three: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js', 'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/' } })}</script></body></html>` })
  : r.continue());
await pg.goto(`${base}/__coin-still.html`);
const shots = {};
for (const bg of ['black', 'white']) {
  await pg.evaluate(async (bg, size) => {
    const [{ createEscalatorScene }, THREE] = await Promise.all([import('/js/sirocco-escalator-scene.js'), import('three')]);
    window.__sc?.renderer.domElement.remove();
    const sc = window.__sc = createEscalatorScene({ width: size, height: size, pixelRatio: 1, framing: 'ref', theme: 'terracotta-gloss', bloom: false, preserveDrawingBuffer: true });
    const pivot = sc.coin.parent;
    sc.scene.traverse(o => { if ((o.isMesh || o.isSprite) && !pivot.getObjectById(o.id)) o.visible = false; });
    sc.scene.background = new THREE.Color(bg); sc.scene.fog = null;
    pivot.position.set(0, 0, 0); pivot.scale.setScalar(1);
    pivot.quaternion.setFromEuler(new THREE.Euler(-0.18, 0.5, 0.05, 'YXZ'));
    sc.coin.quaternion.identity();
    sc.camera.clearViewOffset(); sc.camera.fov = 14; sc.camera.aspect = 1; sc.camera.position.set(0, 0.05, 2.9); sc.camera.lookAt(0, 0, 0); sc.camera.updateProjectionMatrix();
    sc.key.position.set(-2.5, 4, 4); sc.key.intensity *= 1.15;
    sc.renderer.setClearColor(bg, 1); sc.renderer.render(sc.scene, sc.camera);
    const c = sc.renderer.domElement; c.style.cssText = 'position:fixed;inset:0'; document.body.appendChild(c);
  }, bg, +size);
  await new Promise(r => setTimeout(r, 400));
  shots[bg] = `/tmp/coin-still-${bg}.png`;
  await pg.screenshot({ path: shots[bg], omitBackground: false });
}
await b.close();
// alpha = 1 - (white - black); colour = black / alpha
execFileSync('magick', [shots.black, shots.white, '-compose', 'difference', '-composite', '-colorspace', 'gray', '-negate', '/tmp/coin-still-a.png']);
execFileSync('magick', [shots.black, '/tmp/coin-still-a.png', '-fx', 'v.r > 0.004 ? u / v.r : 0', '/tmp/coin-still-c.png']);
execFileSync('magick', ['/tmp/coin-still-c.png', '/tmp/coin-still-a.png', '-alpha', 'off', '-compose', 'copy-opacity', '-composite', '-trim', '+repage', '-resize', 'x640', out]);
console.log('wrote', out);
