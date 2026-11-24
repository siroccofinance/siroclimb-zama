// Sirocco "escalator" scene, rebuilt from the Nickel hero reference (5 s, 150 frames @30fps):
// a belt of square tiles flows from the flat landing (right) towards the left, where the tiles
// rise into an escalator of blocks; the coin stands on the landing edge and rolls in place,
// wobbling. Measured from the reference: one tile every 15 frames (0.5 s), coin wobble 75 frames.
import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SIROCCO_LOGO_PATH } from './logo-path.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { inverseACES, SIROCCO_COLORS, THEMES as HERO_THEMES } from './sirocco-coin-scene.js';

export const ESC_LOOP = 5;                 // seconds
const STEP_T = 0.5;                         // one tile passes every 0.5 s
const WOBBLE_T = 2.5;                       // coin wobble period
const D = 1.0;                              // tile depth (along the belt)
const W = 1.0;                              // belt width
const RISE = 0.8;                           // height gained per tile once the escalator is steep
const EASE = 0.55;                          // length of the flat→steep transition (in tiles)
const SPEED = D / STEP_T;
const RC = (SPEED * ESC_LOOP) / (2 * Math.PI * 5); // coin radius: exactly 5 turns per loop (≈0.32)
const TC = 0.1;                             // coin thickness
const N_TILES = 40;

export const ESC_THEMES = {
  // hero terracotta ground, sand belt, gold coin (Sirocco charter)
  terracotta: { bg: '#8f3517', floor: '#9a3a19', floorLine: '#c96a44', floorShade: '#4a1607', tile: '#fbefe4', side: '#6e2a12', key: ['#fff3e8', 3.4], hemi: ['#ffc6a8', '#3a1206', 0.12], fill: ['#ffd9c4', 0.0], exposure: 1.0 },
  // same rig on the dark Sirocco ink, closest to the reference mood
  noir: { bg: '#16100d', floor: '#1a1310', floorLine: '#2a1e18', floorShade: '#000000', tile: '#f6ece2', side: '#2a201b', key: ['#fff3e8', 3.6], hemi: ['#7a5444', '#050302', 0.15], fill: ['#ffd9c4', 0.0], exposure: 1.0 },
};

// the landing hero's art direction, verbatim: glossy lacquered terracotta steps, warm key from behind
// that flashes the treads, rim light, coin glow + halo, bloom, fog (see sirocco-coin-scene.js THEMES)
ESC_THEMES['terracotta-gloss'] = { ...HERO_THEMES['terracotta-gloss'], gloss: true };
ESC_THEMES['noir-gloss'] = { ...HERO_THEMES.noir, gloss: true };

// height of a tile whose centre is at belt position x (x < 0 = past the landing edge)
// rises for STEPS tiles past the landing, then a flat ceiling (the last two blocks level, like the ref)
const STEPS = 3;
function heightAt(x, rise = RISE) {
  const d = Math.min(-x, STEPS * D);
  if (d <= 0) return 0;
  return (rise / D) * d;
}

function grainTexture(size = 1024) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    // fine stipple, like the reference's micro-dotted print texture
    const v = 128 + (Math.random() - 0.5) * 120;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2);
  t.anisotropy = 8;
  return t;
}

// coin edge reeding: fine ridges on the lathe's outer wall only (UV v of that band), as a bump map.
// The lathe's u runs around the coin, so the ridges roll with the body and show the coin turning.
function reedingTexture() {
  const w = 2048, h = 256, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
  const v0 = Math.floor(h * 6 / 13) + 2, v1 = Math.ceil(h * 7 / 13) - 2, N = 180;   // the straight wall of the profile
  for (let i = 0; i < N; i++) {
    const x = (i / N) * w, gr = g.createLinearGradient(x, 0, x + w / N, 0);
    gr.addColorStop(0, '#3a3a3a'); gr.addColorStop(0.5, '#e8e8e8'); gr.addColorStop(1, '#3a3a3a');
    g.fillStyle = gr; g.fillRect(x, v0, w / N, v1 - v0);
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8; return t;
}
// proof finish: a polished field with faint concentric hairlines, the mark frosted (satin) so it reads bright
// against the mirror-like field from every angle
function brushedTexture(size = 1024) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, size, size);
  const m = size / 2;
  for (let r = 1; r < m; r += 0.75) {
    const v = 128 + (Math.random() - 0.5) * 40;
    g.strokeStyle = `rgb(${v},${v},${v})`; g.lineWidth = 0.75; g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.anisotropy = 8; return t;
}

const FLOOR_FRAG = /* glsl */`
uniform vec3 uBase; uniform vec3 uLine; uniform vec3 uShade; varying vec2 vP;
void main(){
  // faint large floor panels
  vec2 g = abs(fract(vP / 2.4) - 0.5);
  float line = smoothstep(0.497, 0.4995, max(g.x, g.y));
  // big soft out-of-focus shadow sweeps (static), like the reference
  float a = dot(vP, normalize(vec2(1.0, -0.35)));
  float b = dot(vP, normalize(vec2(0.35, 1.0)));
  float sh = smoothstep(-1.5, 2.5, sin(a * 0.42 + 0.8 * sin(b * 0.3)) ) * 0.75;
  vec3 col = mix(uBase, uShade, sh * 0.55) + uLine * line * 0.08;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const ESC_FRAMINGS = {
  ref:  { fov: 12.5, shiftX: 0.0, shiftY: 0.0 },
  hero: { fov: 20, shiftX: 0.14, shiftY: 0.0 },
  site: { fov: 17, shiftX: 0.0, shiftY: 0.14 },   // 16:9 web hero: scene in the upper band, room for the headline bottom-left
  site2: { fov: 19, shiftX: 0.04, shiftY: 0.18 },
};

export function createEscalatorScene({ canvas, width, height, pixelRatio = 1, framing = 'ref', theme = 'terracotta', bloom = true, shadows = true, preserveDrawingBuffer = false } = {}) {
  const TH = ESC_THEMES[theme] || ESC_THEMES.terracotta;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TH.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const G = !!TH.gloss;
  const scene = new THREE.Scene();
  const bgIn = inverseACES(new THREE.Color(TH.bg), TH.exposure);
  scene.background = bgIn;
  if (G) scene.fog = new THREE.Fog(bgIn, 13.5, 22); // hero fog, rescaled to this camera distance
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  scene.environment = envTex;

  // floor
  const floorMat = new THREE.ShaderMaterial({
    uniforms: { uBase: { value: inverseACES(new THREE.Color(TH.floor), TH.exposure) }, uLine: { value: new THREE.Color(TH.floorLine) }, uShade: { value: inverseACES(new THREE.Color(TH.floorShade), TH.exposure) } },
    vertexShader: 'varying vec2 vP; void main(){ vP = (modelMatrix * vec4(position,1.0)).xz; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }',
    fragmentShader: FLOOR_FRAG,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.7;
  floor.visible = !G;
  scene.add(floor);
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: 0.35 }));
  catcher.rotation.x = -Math.PI / 2; catcher.position.y = -0.695; catcher.receiveShadow = true; catcher.visible = !G;
  scene.add(catcher);

  // tiles: boxes whose top follows heightAt(); a tall box so its risers and sides show
  const grain = grainTexture();
  const tileMat = new THREE.MeshStandardMaterial({ color: TH.tile, roughness: 0.62, metalness: 0.0, bumpMap: grain, bumpScale: 1.6, envMapIntensity: 0.06 });
  const tileMat2 = tileMat.clone(); tileMat2.color.multiplyScalar(0.94);
  const sideMat = new THREE.MeshStandardMaterial({ color: TH.side, roughness: 0.7, metalness: 0.0, bumpMap: grain, bumpScale: 1.2, envMapIntensity: 0.15 });
  // BoxGeometry face order: +x, -x, +y (tread), -y, +z, -z
  const mats = [tileMat, tileMat, tileMat, sideMat, sideMat, sideMat], mats2 = [tileMat2, tileMat2, tileMat2, sideMat, sideMat, sideMat];
  const BOX_H = 30;
  const stepMat = G ? new THREE.MeshStandardMaterial({ color: TH.step, roughness: TH.stepRough, metalness: TH.stepMetal, envMapIntensity: TH.stepEnv }) : null;
  const tileGeo = G ? new RoundedBoxGeometry(D * 0.996, BOX_H, W, 3, 0.018) : new THREE.BoxGeometry(D * 0.996, BOX_H, W);
  tileGeo.translate(0, -BOX_H / 2, 0); // origin at the top face
  const tiles = [];
  for (let i = 0; i < N_TILES; i++) {
    const m = new THREE.Mesh(tileGeo, G ? stepMat : (i % 2 ? mats : mats2));
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m); tiles.push(m);
  }

  // coin: a lathed body (reeded edge, raised rim) that rolls, and a face that does not. The face is a
  // polished field with the Sirocco mark struck on it in frosted relief, built from the vector logo
  // (crisp at any size). It stays upright while the body rolls under it, on both sides.
  const coin = new THREE.Group();
  const coinMat = new THREE.MeshPhysicalMaterial({ color: SIROCCO_COLORS.coin, metalness: 1, roughness: 0.26, clearcoat: 0.35, clearcoatRoughness: 0.15, envMapIntensity: G ? TH.coinEnv : 1.0, bumpMap: reedingTexture(), bumpScale: 2.2 });
  const fieldMat = new THREE.MeshPhysicalMaterial({ color: '#e2a650', metalness: 1, roughness: 0.17, clearcoat: 0.7, clearcoatRoughness: 0.08, envMapIntensity: G ? TH.coinEnv : 1.0, bumpMap: brushedTexture(), bumpScale: 0.35 });
  const logoMat = new THREE.MeshPhysicalMaterial({ color: '#f4cb58', metalness: 1, roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.3, envMapIntensity: G ? TH.coinEnv + 0.15 : 1.2 });
  const face = new THREE.Group();
  {
    const k = RC / 0.30, t = TC / 2, hf = t - 0.008, pts = [];
    const add = (r, h) => pts.push(new THREE.Vector2(r * k, h));
    add(0, -hf); add(0.238, -hf); add(0.246, -t + 0.001); add(0.252, -t);
    add(0.285, -t); add(0.296, -t + 0.004); add(0.30, -t + 0.012);
    add(0.30, t - 0.012); add(0.296, t - 0.004); add(0.285, t);
    add(0.252, t); add(0.246, t - 0.001); add(0.238, hf); add(0, hf);
    const g = new THREE.LatheGeometry(pts, 192); g.rotateX(Math.PI / 2);
    const body = new THREE.Mesh(g, coinMat); body.castShadow = true; body.receiveShadow = true; coin.add(body);
    // polished field over the flat of each face (concentric hairlines, so it can sit on the face group)
    const fg = new THREE.CircleGeometry(0.2385 * k, 160);
    const f1 = new THREE.Mesh(fg, fieldMat); f1.position.z = hf + 0.0004; f1.receiveShadow = true;
    const f2 = new THREE.Mesh(fg, fieldMat); f2.rotation.x = Math.PI; f2.position.z = -hf - 0.0004; f2.receiveShadow = true;
    face.add(f1, f2);
    // the mark: extruded from the brand path, a short crisp chamfer, centred on its own bounds and sized to the field
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="14 14 250 309"><path d="${SIROCCO_LOGO_PATH}"/></svg>`;
    const shapes = new SVGLoader().parse(svg).paths.flatMap(p => SVGLoader.createShapes(p));
    const outline = shapes.flatMap(sh => sh.getPoints(64)), { x: cx, y: cy } = new THREE.Box2().setFromPoints(outline).getCenter(new THREE.Vector2());
    const rmax = Math.max(...outline.map(p => Math.hypot(p.x - cx, p.y - cy)));
    const depth = 7, bt = 2.4, bs = 1.6, s = (0.198 * k) / (rmax + bs);
    const lg = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: true, bevelThickness: bt, bevelSize: bs, bevelOffset: -bs, bevelSegments: 5, curveSegments: 96 });
    lg.translate(-cx, -cy, 0); lg.scale(s, -s, -s); lg.translate(0, 0, (depth + bt) * s);
    const faceZ = hf;
    const front = new THREE.Mesh(lg, logoMat); front.position.z = faceZ; front.castShadow = true;
    // the back mark is turned about the horizontal axis: after a flip (the coin tosses end over end) it reads upright too
    const back = new THREE.Mesh(lg, logoMat); back.rotation.x = Math.PI; back.position.z = -faceZ; back.castShadow = true;
    face.add(front, back);
  }
  coinMat.fog = false; logoMat.fog = false; fieldMat.fog = false; // the coin never dissolves into the terracotta
  const coinPivot = new THREE.Group(); // stands on the belt, yaw wobble applied here
  coinPivot.add(coin, face);
  scene.add(coinPivot);

  // lights: strong key from behind-left and above (bright treads, grey risers, black front sides)
  scene.add(new THREE.HemisphereLight(...TH.hemi));
  const key = new THREE.DirectionalLight(...TH.key);
  key.position.set(-6, 9, -6); key.target.position.set(0, 0, 0);
  let glow = null, halo = null, flash = null;
  if (G) {
    // hero rig offsets (relative to the coin): key behind/above, rim grazing from behind, fill from the camera side
    const C = new THREE.Vector3(1.15, 0.3, 0);
    key.position.copy(C).add(new THREE.Vector3(2.2, 5.5, -2.0)); key.target.position.copy(C);
    const rim = new THREE.DirectionalLight(...TH.rim); rim.position.copy(C).add(new THREE.Vector3(3.5, 1.6, -4.5)); rim.target.position.copy(C);
    scene.add(rim, rim.target);
    glow = new THREE.PointLight(TH.glow[0], TH.glow[1], 2.5, 2); scene.add(glow);
    // the hero's blown white flash on a tread: a warm point light placed at the mirror of the view
    flash = new THREE.PointLight('#fff1e0', 0, 0, 2); scene.add(flash);
    const hc = document.createElement('canvas'); hc.width = hc.height = 512;
    const x = hc.getContext('2d'), gr = x.createRadialGradient(256, 256, 0, 256, 256, 256);
    const [c0, c1] = (TH.haloColor || ['#ff8c50', '#c2552d']).map(h => new THREE.Color(h).getRGB({}, THREE.SRGBColorSpace));
    const rgba = (c, a) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
    gr.addColorStop(0, rgba(c0, 0.9)); gr.addColorStop(0.35, rgba(c1, 0.35)); gr.addColorStop(1, rgba(c1, 0));
    x.fillStyle = gr; x.fillRect(0, 0, 512, 512);
    const ht = new THREE.CanvasTexture(hc); ht.colorSpace = THREE.SRGBColorSpace;
    halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: ht, transparent: true, opacity: TH.halo, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    halo.scale.setScalar(1.9 * RC / 0.3); scene.add(halo);
  }
  key.castShadow = shadows; key.shadow.mapSize.set(4096, 4096);
  Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 0.5, far: 40 });
  key.shadow.bias = -0.0003; key.shadow.normalBias = 0.015; key.shadow.radius = 4;
  const fill = new THREE.DirectionalLight(...TH.fill); fill.position.set(6, 4, 3);
  if (G) { fill.position.set(1.15 - 4, 0.3 + 1.5, 4); fill.target.position.set(1.15, 0.3, 0); scene.add(fill.target); }
  scene.add(key, key.target, fill);

  const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 200);
  // frontal, slightly high, rolled (Dutch angle) like the reference: belt rises to the top-right
  const cam = { p: new THREE.Vector3(-7.342, 12.076, 6.892), l: new THREE.Vector3(-0.15, 0.78, -0.3), up: new THREE.Vector3(0, 1, 0) }; // Nickel ref: no roll, 3/4 from the front-left, 48° down
  function placeCamera() { camera.position.copy(cam.p); camera.up.copy(cam.up); camera.lookAt(cam.l); }
  placeCamera();

  let composer = null, bloomPass = null, bloomBase = 0;
  // launch light: a hot warm-white burst on the box top as it fires
  const pop = G ? new THREE.PointLight('#fff4e6', 0, 3.5, 2) : null; if (pop) scene.add(pop);
  if (bloom) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bgLum = 0.2126 * bgIn.r + 0.7152 * bgIn.g + 0.0722 * bgIn.b;
    bloomPass = G ? new UnrealBloomPass(new THREE.Vector2(256, 256), TH.bloom[0], TH.bloom[1], Math.max(TH.bloom[2], bgLum * 1.35)) : new UnrealBloomPass(new THREE.Vector2(256, 256), 0.12, 0.45, 0.95);
    bloomBase = bloomPass.strength; composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  }

  const TAU = Math.PI * 2, AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
  const q1 = new THREE.Quaternion(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
  const COIN_X = 1.15;               // clear of the first rising block (tiles rise once their centre passes x=0)
  const ZIG_A = W / 2 - 0.14;        // weave across the full belt width, rim never past the edge
  // idle loop state at belt travel `dist` and clock `time` (seconds)
  function loopState(dist, time) {
    const ph = TAU * (time / WOBBLE_T);
    const zig = ZIG_A * Math.sin(ph), vz = ZIG_A * (TAU / WOBBLE_T) * Math.cos(ph);
    return { dist, zig, yaw: Math.atan2(-vz, SPEED), lean: 0.04 * Math.sin(ph + 1.2), cx: COIN_X };
  }
  const tileX = (i, dist) => (i - N_TILES / 2) * D + D / 2 - (dist % (2 * D)) + 8;
  // o: { dist, zig, yaw, lean, cx, lift (box under the coin), liftX, cy (coin height above its box), flip, spin, flashI, pop, camY }
  function pose(o) {
    const P = (typeof window !== 'undefined' && window.__escP) || {};
    const rise = P.rise ?? RISE, cs = P.cs ?? 1;
    for (let i = 0; i < N_TILES; i++) {
      if (o.tilePos) { const [x, y] = o.tilePos(i); tiles[i].position.set(x, y, 0); continue; }
      const x = tileX(i, o.dist);
      const lifted = o.lift && Math.abs(x - o.liftX) < D * 0.25;
      tiles[i].position.set(x, heightAt(x, rise) + (lifted ? o.lift : 0), 0);
    }
    // coin rolls against the belt: relative travel = belt travel + its own drift along the belt
    const roll = -(o.dist + (o.cx - COIN_X)) / RC + (o.spin || 0);
    coin.quaternion.setFromAxisAngle(AZ, roll);         // the body rolls; the face (mark) stays upright
    coinPivot.quaternion.setFromAxisAngle(AY, o.yaw).multiply(q1.setFromAxisAngle(AX, o.lean + (o.flip || 0)));
    coinPivot.scale.setScalar(cs);
    coinPivot.position.set(o.cx, RC * cs + (o.cy || 0), o.zig);
    if (flash) {
      const fx = P.fx ?? -0.5, fy = P.fy ?? 0.5, fz = P.fz ?? 0.0, fd = P.fd ?? 1.5;
      v1.copy(camera.position).sub(v2.set(fx, fy, fz)).normalize(); v1.x = -v1.x; v1.z = -v1.z;
      flash.position.set(fx, fy, fz).addScaledVector(v1, fd); flash.intensity = o.flashI ?? P.fi ?? 9;
    }
    if (pop) { pop.position.set(o.liftX ?? COIN_X, (o.lift || 0) + 0.9, 0.35); pop.intensity = o.pop || 0; }
    if (bloomPass) bloomPass.strength = bloomBase + (o.bloomUp || 0);
    camera.position.copy(cam.p); camera.lookAt(cam.l);
    if (o.camY) { camera.position.y += o.camY; v1.copy(cam.l); v1.y += o.camY; camera.lookAt(v1); }
    if (scene.fog) { const f = (o.follow || 0) ** 2; scene.fog.near = 13.5 + (2.5 - 13.5) * f; scene.fog.far = 22 + (7.0 - 22) * f; }
    if (o.follow) {
      const a = o.follow;
      v1.copy(cam.l); v1.y += o.camY || 0; v1.lerp(coinPivot.position, a);   // look target slides onto the coin
      camera.position.copy(cam.p).sub(cam.l).multiplyScalar(1 - L.DOLLY * a).add(v1);
      camera.lookAt(v1);
      if (camera.view) { camera.view.offsetX = viewBase.x + (viewMid.x - viewBase.x) * a; camera.view.offsetY = viewBase.y + (viewMid.y - viewBase.y) * a; camera.updateProjectionMatrix(); }
    } else if (camera.view && (camera.view.offsetX !== viewBase.x || camera.view.offsetY !== viewBase.y)) { camera.view.offsetX = viewBase.x; camera.view.offsetY = viewBase.y; camera.updateProjectionMatrix(); }
    if (glow) glow.position.copy(coinPivot.position).add(v1.set(0.35, 0.45, -0.7));
    if (glow) glow.intensity = TH.glow[1] * (1 - 0.6 * (o.follow || 0));
    if (halo) halo.material.opacity = TH.halo * (1 - 0.5 * (o.follow || 0));
    if (halo) { v1.copy(coinPivot.position).sub(camera.position).normalize().multiplyScalar(0.9); halo.position.copy(coinPivot.position).add(v1); halo.position.y += 0.12; }
  }
  function setTime(t) { pose(loopState(t * SPEED, t)); }

  // ── launch: the belt brakes, the coin settles on the centre of the box it stands on, the box dips,
  //    then springs up and tosses the coin (flipping) into the air. Times in seconds from the click.
  const L = { TS: 0.42, TA: 0.16, TL: 0.30, LIFT: 0.95, G: 9, V0: 6.2, FLIP: 2.4, FOLLOW_T: 0.75, DOLLY: 0.55 };
  const ease = { sm: u => u * u * (3 - 2 * u), inOut3: u => u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2, in2: u => u * u };
  const clamp01 = u => Math.min(1, Math.max(0, u));
  function planLaunch(dist0, time0) {
    const s0 = loopState(dist0, time0);
    const d1 = dist0 + SPEED * L.TS / 2;           // ease-out braking distance (speed continuous at the click)
    let bx = Infinity;                              // box whose centre is closest to the coin once stopped
    for (let i = 0; i < N_TILES; i++) { const x = tileX(i, d1); if (Math.abs(x - COIN_X) < Math.abs(bx - COIN_X)) bx = x; }
    return { s0, d1, boxX: bx, time0 };
  }
  // braking + settling onto the box (shared by the landing launch and the game start)
  function brakeState(pl, tl) {
    const { s0, boxX } = pl, TS = L.TS;
    const u = clamp01(tl / TS), e = ease.sm(u);
    return { dist: s0.dist + SPEED * TS * (u - u * u / 2), zig: s0.zig * (1 - e), yaw: s0.yaw * (1 - e), lean: s0.lean * (1 - e),
      cx: COIN_X + (boxX - COIN_X) * e, liftX: boxX, lift: 0, cy: 0, pop: 0, bloomUp: 0, camY: 0, flip: 0, spin: 0, follow: 0 };
  }
  // dip, spring and toss from a box already raised to `base`; tt = seconds since the dip starts
  function applyToss(o, tt, base = 0, hover = false) {
    const { TA, TL, LIFT, G: g, V0, FLIP } = L, tSep = TA + TL * 0.5;
    if (tt <= 0) return o;
    o.lift = base - 0.07 * ease.sm(clamp01(tt / TA));
    if (tt > TA) {
      const w = clamp01((tt - TA) / TL);
      o.lift = base - 0.07 + (LIFT + 0.07) * ease.inOut3(w);
      if (tt > TA + TL) { const k = tt - TA - TL; o.lift = base + LIFT + 0.06 * Math.exp(-k * 9) * Math.sin(k * 26); }
      o.pop = 9 * Math.exp(-Math.pow((tt - tSep) / 0.09, 2));
      o.bloomUp = 0.18 * Math.exp(-Math.pow((tt - tSep) / 0.12, 2));
    }
    if (tt <= tSep) o.cy = o.lift;
    else {
      let k = tt - tSep; const ySep = base - 0.07 + (LIFT + 0.07) * 0.5, kApex = V0 / g;
      const kk = hover ? Math.min(k, kApex) : k;    // hover: the coin hangs at the top of its arc
      o.cy = Math.max(o.lift, ySep + V0 * kk - 0.5 * g * kk * kk + (hover && k > kApex ? 0.05 * Math.sin((k - kApex) * 2.2) : 0));
      o.flip = -TAU * FLIP * k * (1 - Math.exp(-k * 6));
      if (hover && k > kApex) o.flip = -TAU * FLIP * kApex * (1 - Math.exp(-kApex * 6)) - (k - kApex) * 2.4;
      o.spin = -k * 6;
      o.follow = ease.sm(clamp01(k / L.FOLLOW_T));
    }
    return o;
  }
  function launchPose(pl, tl) {
    const o = brakeState(pl, tl), tA = L.TS, tSep = L.TS + L.TA + L.TL * 0.5;
    applyToss(o, tl - L.TS, 0);
    pose(o);
    return { phase: tl < tA ? 'brake' : tl < tA + L.TA ? 'dip' : tl < tSep ? 'spring' : 'air', tSep };
  }

  // ── game: after the brake, the coin's box climbs one level per leverage step (spring + flash),
  //    the camera rises with it; it ends with a toss (cash out) or a fall (bust).
  const GM = { STEP_H: 0.42, CAM: 0.9 };
  const stepCurve = u => {                          // 0 → 1 with a dip, a fast rise and a small settle
    if (u <= 0) return 0;
    if (u < 0.08) return -0.12 * ease.sm(u / 0.08);
    if (u < 0.30) return -0.12 + 1.12 * ease.inOut3((u - 0.08) / 0.22);
    const k = u - 0.30; return 1 + 0.07 * Math.exp(-k * 9) * Math.sin(k * 26);
  };
  // g: { plan, steps: [seconds since game start], danger 0..1, end: { type: 'cash' | 'bust', at } }, tg = seconds since game start
  function gamePose(g, tg, clock = tg) {
    const o = brakeState(g.plan, tg);
    let lift = 0, pop = 0;
    for (const ts of g.steps) { const u = tg - ts; lift += GM.STEP_H * stepCurve(u); pop += 5 * Math.exp(-Math.pow((u - 0.2) / 0.08, 2)); }
    o.lift = lift; o.cy = lift; o.pop = pop; o.camY = GM.CAM * lift;
    if (g.hop != null) {                             // "ready": the box dips, the coin hops with one full turn and lands
      const k = tg - g.hop, A = 0.11, T = 0.58, V = 7 * T;
      if (k > 0 && k < A) { const d = -0.06 * ease.sm(k / A); o.lift += d; o.cy += d; }
      else if (k >= A && k < A + T) { const kk = k - A; o.cy += V * kk - 7 * kk * kk; o.flip = -TAU * ease.sm(kk / T); }
      else if (k >= A + T) { const q = k - A - T, d = -0.05 * Math.exp(-q * 9) * Math.sin(q * 26); o.lift += d; o.cy += d; }
      o.pop += 3 * Math.exp(-Math.pow((k - A) / 0.07, 2)) + 2 * Math.exp(-Math.pow((k - A - T) / 0.06, 2));
    }
    if (g.go != null) o.pop += 4 * Math.exp(-Math.pow((tg - g.go - 0.06) / 0.09, 2));   // the climb starts: a beat of light on the box
    const settle = ease.sm(clamp01((tg - L.TS) / 0.6));  // alive while it waits: a slow turn of the face
    o.yaw += settle * 0.24 * Math.sin(clock * 0.9); o.lean += settle * 0.035 * Math.sin(clock * 1.3 + 1);
    const d = g.danger || 0;                         // the closer to the fall, the more the coin trembles
    o.lean += d * 0.16 * Math.sin(clock * 15) + d * d * 0.05 * Math.sin(clock * 31);
    o.zig = (o.zig || 0) + d * 0.05 * Math.sin(clock * 9);
    const end = g.end;
    if (end && tg > end.at) {
      const k = tg - end.at, base = lift;
      if (end.type === 'cash') {
        applyToss(o, k, base, true);
        o.camY = GM.CAM * base;
        o.follow = ease.sm(clamp01((k - 0.1) / (L.FOLLOW_T + 0.15)));   // from up the stairs the camera must lock on earlier
      } else {                                       // bust: the box gives way, the coin tips over and drops into the gap
        const f = ease.in2(clamp01(k / 0.55));
        o.lift = base - (base + 2.2) * f;
        const kc = Math.max(0, k - 0.12);
        o.cy = base - 0.5 * 14 * kc * kc;
        o.flip = -Math.min(1.35, kc * kc * 7);
        o.zig += Math.min(0.55, kc * kc * 2.2);
        o.camY = GM.CAM * base * (1 - ease.sm(clamp01(k / 0.9))) - 0.35 * ease.sm(clamp01(k / 0.9));
        o.pop = 0;
      }
    }
    pose(o);
    return o;
  }

  // ── stairs game: the belt keeps rolling and the path follows the price. A tile takes its level a little
  //    before the coin reaches it (so every jump is timed), the path further ahead springs to the live level,
  //    and tiles behind stay frozen: the stairs the coin leaves behind are the price history.
  //    The coin is a disc under gravity that can never go through a tread or a nosing: it jumps just early
  //    enough to clear a riser, rolls over an edge and falls onto a lower tread. 2+ steps: big jump, full turn.
  //    Ends: cash (brake to a tile centre, land, the box pushes the coin up) or bust (the path gives way).
  const TR = { UP: 0.75, SH: 0.4, W: 15, Z: 0.55, ACC: 0.6, BIG: 2, LOOK: 0.7, G: 24 };
  function createTrack(pl) {
    const T = { dist: pl.d1, v: 0, t: 0, hist: new Map(), level: 0, fut: 0, futV: 0, y: 0, vy: 0, air: false,
      flip: 0, camY: 0, cxOff: pl.boxX - COIN_X, cx: pl.boxX, initDist: pl.d1, end: null, events: [], danger: 0, landT: -9, landBig: false };
    const uc = T.cx + T.dist;
    T.lastG = Math.floor((uc + RC + TR.LOOK) / D);
    T.handled = Math.floor(uc / D);
    return T;
  }
  const gOf = (T, g) => g * D + D / 2 - T.dist;                    // tile centre, scene x
  function baseH(T, g) {                                         // the hero's escalator flattens out at the start
    return heightAt(g * D + D / 2 - T.initDist, RISE) * (1 - ease.sm(clamp01(T.t / 0.9)));
  }
  function H(T, g) {                                             // physical tread height
    if (g > T.lastG) return T.fut;
    const h = T.hist.get(g); return h ? h.y : baseH(T, g);
  }
  function dispH(T, g) {                                         // drawn height: a freshly set tile eases in
    if (g > T.lastG) return T.fut;
    const h = T.hist.get(g); if (!h) return baseH(T, g);
    return h.from + (h.y - h.from) * ease.sm(clamp01((T.t - h.t) / 0.18));
  }
  function support(T, uc) {                                      // lowest the coin's bottom may be (disc vs treads)
    let s = -1e9;
    for (let g = Math.floor((uc - RC) / D); g <= Math.floor((uc + RC) / D); g++) {
      const x0 = g * D, x1 = x0 + D, top = H(T, g);
      if (uc >= x0 && uc <= x1) s = Math.max(s, top);
      else { const dx = uc < x0 ? x0 - uc : uc - x1; if (dx < RC) s = Math.max(s, top - RC + Math.sqrt(RC * RC - dx * dx)); }
    }
    return s;
  }
  function launch(T, v0, big, n, targetY) {
    T.air = true; T.vy = v0; T.airT0 = T.t; T.big = big;
    const apex = T.y + v0 * v0 / (2 * TR.G);
    T.airDur = v0 / TR.G + Math.sqrt(2 * Math.max(0.01, apex - targetY) / TR.G);
    T.flipDir = big ? (n > 0 ? -1 : 1) : 0;
  }
  // level: integer steps (favourable move). dt in s.
  function trackStep(T, dt, level) {
    T.t += dt;
    if (T.events.length > 12) T.events.splice(0, T.events.length - 12);
    const e = T.end;
    if (e && e.type === 'bust') { T.v = Math.max(0, T.v - dt * 7); T.dist += T.v * dt; return T; }
    if (!e) { T.v = SPEED * ease.sm(clamp01(T.t / TR.ACC)); T.dist += T.v * dt; T.level = level; }
    else {                                                       // cash: ease-out to an exact tile centre
      const u = clamp01((T.t - e.at) / e.TB);
      T.dist = e.d0 + e.D * (2 * u - u * u); T.v = (e.D * (2 - 2 * u)) / e.TB;
    }
    T.cx = COIN_X + T.cxOff * (1 - ease.sm(clamp01(T.t / 0.9)));
    const tgt = T.level * TR.SH, a = TR.W * TR.W * (tgt - T.fut) - 2 * TR.Z * TR.W * T.futV;
    T.futV += a * dt; T.fut += T.futV * dt;
    const uc = T.cx + T.dist;
    // set the tiles the coin is about to reach
    const gN = Math.floor((uc + RC + TR.LOOK) / D);
    while (T.lastG < gN) { T.lastG++; T.hist.set(T.lastG, { y: T.level * TR.SH, from: T.fut, t: T.t }); }
    for (const k of T.hist.keys()) { if (k < T.lastG - 60) T.hist.delete(k); else break; }
    // the next riser or edge
    const g1 = T.handled + 1, xb = g1 * D, dy = H(T, g1) - H(T, g1 - 1), n = Math.round(dy / TR.SH);
    const big = Math.abs(n) >= TR.BIG;
    if (T.air) { if (uc >= xb + 0.2) T.handled = g1; }
    else if (dy > 0.02) {                                        // riser ahead: leave the tread just in time to clear it
      const A = big ? 0.5 + 0.05 * Math.min(5, Math.abs(n)) : 0.12, v0 = Math.sqrt(2 * TR.G * (dy + A));
      const tc = (v0 - Math.sqrt(Math.max(0, v0 * v0 - 2 * TR.G * (dy + 0.04)))) / TR.G;
      if (xb - (uc + RC * 0.7) <= Math.max(T.v, 0.15) * tc || uc + RC >= xb) {
        launch(T, v0, big, n, H(T, g1)); T.handled = g1; T.events.push({ t: T.t, n, big }); T.onStep?.(n, big);
      }
    } else if (dy < -0.02) {                                     // edge ahead: roll off it (a big drop: hop and turn)
      if (big && uc >= xb - 0.1) { launch(T, Math.sqrt(2 * TR.G * 0.4), true, n, H(T, g1)); T.handled = g1; T.events.push({ t: T.t, n, big }); T.onStep?.(n, big); }
      else if (!big && uc >= xb) { T.handled = g1; T.events.push({ t: T.t, n, big }); T.onStep?.(n, big); }
    } else if (uc >= xb) T.handled = g1;
    // gravity, then the treads push back
    T.vy -= TR.G * dt; T.y += T.vy * dt;
    const sup = support(T, uc);
    if (T.y <= sup) {
      if (T.air || T.vy < -1.5) { T.landT = T.t; T.landBig = !!T.big && T.air; T.landV = -T.vy; }
      T.y = sup; T.vy = 0; T.air = false; T.big = false;
    }
    T.flip = T.air && T.flipDir ? T.flipDir * TAU * ease.sm(clamp01((T.t - T.airT0) / (T.airDur * 0.92))) : 0;
    // the camera rides with the coin, a little behind
    T.camY += (T.y - T.camY) * (1 - Math.exp(-dt * 3.2));
    // cash: once stopped and resting on its tread, the box pushes the coin up
    if (e && e.tossAt == null && T.t - e.at >= e.TB && !T.air && Math.abs(T.y - sup) < 1e-3) {
      e.rest = (e.rest || 0) + dt; if (e.rest >= 0.06) e.tossAt = T.t;
    }
    return T;
  }
  function trackPose(T, clock, danger = 0) {
    const e = T.end, k = e ? T.t - e.at : 0;
    const s = loopState(T.dist, T.t), ramp = ease.sm(clamp01(T.t / 0.9));
    const calm = e && e.type === 'cash' ? 1 - ease.sm(clamp01(k / e.TB)) : 1;
    const o = { dist: T.dist, zig: s.zig * ramp * calm, yaw: s.yaw * ramp * calm, lean: s.lean * ramp * calm,
      cx: T.cx, cy: T.y, flip: T.flip, spin: 0, pop: 0, bloomUp: 0, camY: T.camY + TR.UP * ramp, follow: 0, lift: 0, liftX: T.cx };
    // light where the coin lands
    o.pop += (T.landBig ? 6 : Math.min(2, 0.4 * (T.landV || 0))) * Math.exp(-Math.pow((T.t - T.landT) / (T.landBig ? 0.09 : 0.07), 2));
    if (!e) { o.lean += danger * 0.16 * Math.sin(clock * 15) + danger * danger * 0.05 * Math.sin(clock * 31); o.zig += danger * 0.05 * Math.sin(clock * 9); }
    let liftG = null, lift = 0, drop = null;
    if (e && e.type === 'cash') {
      liftG = e.boxG; o.liftX = gOf(T, e.boxG);
      if (e.tossAt != null) {
        const t2 = T.t - e.tossAt;
        applyToss(o, t2, 0, true); lift = o.lift; o.cy = T.y + (o.cy || 0);
        if (t2 >= L.TA + L.TL * 0.5 + 0.5) e.ready = true;      // the coin is pushed and flying: show the result
      }
      o.camY = T.camY + TR.UP;
    } else if (e && e.type === 'bust') {             // the path gives way under the coin, it tips and falls
      const kc = Math.max(0, k - 0.1);
      drop = { g: e.g, d: 0.5 * 9 * k * k };
      o.cy = T.y - 0.5 * 14 * kc * kc;
      o.flip = -Math.min(1.35, kc * kc * 7); o.zig += Math.min(0.55, kc * kc * 2.2);
      o.camY = T.camY + TR.UP - 0.4 * ease.sm(clamp01(k / 0.9));
      if (k >= 1.05) e.ready = true;
    }
    const gStart = Math.floor(T.dist - 12);
    o.tilePos = i => {
      const g = gStart + i;
      let y = dispH(T, g);
      if (liftG !== null && g === liftG) y += lift;
      if (drop && g >= drop.g) y -= drop.d * (1 + 0.25 * (g - drop.g));
      return [gOf(T, g), y];
    };
    pose(o);
    return o;
  }
  function trackEnd(T, type) {
    if (T.end) return;
    const uc = T.cx + T.dist;
    if (type === 'cash') {
      // stop on a tile centre ahead (never backwards); mid-air, past where it will land
      const lead = T.air ? Math.max(0.6, T.v * 0.35) : 0.3;
      const c = Math.ceil((uc + lead - D / 2) / D) * D + D / 2;
      const Dd = c - uc, TB = Math.min(0.9, Math.max(0.35, 2 * Dd / Math.max(T.v, 0.1)));
      T.end = { type, at: T.t, d0: T.dist, D: Dd, TB, boxG: Math.floor(c / D) };
    } else T.end = { type, at: T.t, g: Math.floor(uc / D) };
  }
  function coinNDC() { return v2.copy(coinPivot.position).project(camera); }

  let frame = ESC_FRAMINGS[framing] || ESC_FRAMINGS.ref;
  // cover: { aspect, x, y } crops a virtual frame of that aspect like CSS object-fit: cover / object-position,
  // so the live canvas lines up with the video at any viewport size
  let cover = null; const viewBase = { x: 0, y: 0 }, viewMid = { x: 0, y: 0 };
  function setSize(w, h, dpr = renderer.getPixelRatio(), cv = cover) {
    cover = cv;
    renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
    if (composer) { composer.setPixelRatio(dpr); composer.setSize(w, h); }
    camera.fov = frame.fov;
    let fw = w, fh = h;
    if (cover) { const A = cover.aspect; if (w / h < A) fw = h * A; else fh = w / A; }
    camera.aspect = fw / fh;
    viewBase.x = (fw - w) * (cover ? cover.x : 0.5) - frame.shiftX * fw; viewBase.y = (fh - h) * (cover ? cover.y : 0.5) + frame.shiftY * fh;
    viewMid.x = (fw - w) / 2; viewMid.y = (fh - h) / 2;
    if (cover || frame.shiftX || frame.shiftY) camera.setViewOffset(fw, fh, viewBase.x, viewBase.y, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  function draw() { if (composer) composer.render(); else renderer.render(scene, camera); }
  function render(t) { setTime(t); draw(); }
  function dispose() { scene.traverse(o => o.geometry?.dispose?.()); renderer.dispose(); pmrem.dispose(); envTex.dispose(); grain.dispose(); }
  setSize(width, height, pixelRatio);
  return { renderer, scene, camera, canvas: renderer.domElement, coin, cam, placeCamera, key, setSize, setTime, render, draw, dispose, loopState, pose, planLaunch, launchPose, gamePose, createTrack, trackStep, trackPose, trackEnd, TR, coinNDC, L, GM, SPEED, LOOP: ESC_LOOP };
}
