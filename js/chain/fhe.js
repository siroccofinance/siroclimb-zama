// FHE client: Zama's relayer SDK, loaded from Zama's CDN (window.relayerSDK).
//  - encryption of the player's inputs (side, stake) through the relayer, bound to the sender;
//  - user decryption of the player's own handles (balance, run value) with an EIP-712 grant the
//    wallet signs once a week (the keypair never leaves this browser);
//  - public decryption (published runs, the reserve's synced totals) with the KMS proof the contract checks.
import { ADDR, RPC_URL } from './config.js';

export const RELAYER_SDK_URL = 'https://cdn.zama.org/relayer-sdk-js/0.4.1/relayer-sdk-js.umd.cjs';
let instance = null, scriptP = null;

function loadScript() {
  if (window.relayerSDK) return Promise.resolve();
  scriptP ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = RELAYER_SDK_URL; s.async = true;
    s.onload = res; s.onerror = () => { scriptP = null; rej(new Error('Could not load the Zama relayer SDK')); };
    document.head.appendChild(s);
  });
  return scriptP;
}

export function getFhe() {
  instance ||= (async () => {
    await loadScript();
    const sdk = window.relayerSDK;
    await sdk.initSDK();
    return sdk.createInstance({ ...sdk.SepoliaConfig, network: RPC_URL });
  })().catch(e => { instance = null; throw e; });
  return instance;
}
// ── encryption in a worker (fhe-worker.js): the input proof is ~3.5 s of CPU that froze the 3D scene on
//    this thread. The page's own SDK instance stays for decryptions (light) and as a fallback.
let worker = null, workerReady = null, workerOff = false, seq = 0;
const pending = new Map();
function encWorker() {
  if (workerOff || typeof Worker === 'undefined') return null;
  if (!worker) {
    try { worker = new Worker(new URL('./fhe-worker.js', import.meta.url)); } catch { workerOff = true; return null; }
    worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) return; pending.delete(data.id); data.ok ? p.res(data.v) : p.rej(new Error(data.err)); };
    worker.onerror = () => { workerOff = true; pending.forEach(p => p.rej(new Error('encryption worker failed'))); pending.clear(); };
    workerReady = call('init', { url: RELAYER_SDK_URL, rpc: RPC_URL }).catch(e => { workerOff = true; throw e; });
  }
  return workerReady;
}
function call(op, args) { return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); worker.postMessage({ id, op, args }); }); }
// One encryption at a time (~4 s each). Lobby picks are speculative: a newer pick drops the older ones still
// waiting, so a player who tries a few sides and stakes never queues seconds of stale work; a start goes first.
const jobs = []; let running = false;
export class Superseded extends Error {}
function pump() {
  if (running || !jobs.length) return;
  const j = jobs.shift(); running = true;
  call('encrypt', j.args).then(j.res, j.rej).finally(() => { running = false; pump(); });
}
function queue(args, speculative) {
  return new Promise((res, rej) => {
    if (speculative) for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].speculative) jobs.splice(i, 1)[0].rej(new Superseded('superseded'));
    const j = { args, speculative, res, rej };
    speculative ? jobs.push(j) : jobs.unshift(j);
    pump();
  });
}
// { contract, user, bool?, u64? } → { handles, inputProof }: in the worker, else on this thread
async function encryptInput(args, speculative = false) {
  const w = encWorker();
  if (w) {
    try { await w; return await queue({ ...args, u64: args.u64 == null ? null : String(args.u64) }, speculative); }
    catch (e) { if (e instanceof Superseded || !workerOff) throw e; }   // the worker itself failed: this thread takes over
  }
  const fhe = await getFhe();
  const input = fhe.createEncryptedInput(args.contract, args.user);
  if (args.bool != null) input.addBool(args.bool);
  if (args.u64 != null) input.add64(BigInt(args.u64));
  return input.encrypt();
}

/** Starts loading the SDK and its WASM in the background (first encryption is then instant). */
export const warmUp = () => { encWorker()?.catch(() => {}); return getFhe().catch(() => {}); };

/** A relayer request can hang without an answer: give up after `ms` and try again (3 attempts). */
async function relayer(fn, ms, what) {
  for (let attempt = 0; ; attempt++) {
    try { return await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`The Zama relayer did not answer (${what})`)), ms))]); }
    catch (e) { if (attempt >= 2) throw e; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
  }
}

const hex = b => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** Encrypts a run's side (ebool) and optionally its stake (euint64, 6 decimals) for `sender`. */
export async function encryptRun(sender, long, stakeUnits, { speculative = false } = {}) {
  const run = () => encryptInput({ contract: ADDR.Siroclimb, user: sender, bool: long, u64: stakeUnits }, speculative);
  const enc = speculative ? await run() : await relayer(run, 40_000, 'encryption');
  return { handles: enc.handles.map(hex), proof: hex(enc.inputProof) };
}

/** Encrypts one amount (euint64, 6 decimals) for `contract`, bound to `sender` (reserve deposits, withdrawals). */
export async function encryptAmount(contract, sender, units) {
  const enc = await relayer(() => encryptInput({ contract, user: sender, u64: units }), 40_000, 'encryption');
  return { handle: hex(enc.handles[0]), proof: hex(enc.inputProof) };
}

// ── user decryption grant (one wallet signature per day, kept in this tab's local storage)
const DAYS = 7;   // one decryption signature a week
const grantKey = user => `siroclimb:fhe-grant:${user.toLowerCase()}`;
const CONTRACTS = () => [ADDR.Siroclimb, ADDR.StakeToken, ADDR.SiroccoReserve];
function loadGrant(user) {
  try {
    const g = JSON.parse(localStorage.getItem(grantKey(user)) || 'null');
    if (!g || g.start + g.days * 86400 - 600 < Date.now() / 1000 || g.contracts !== CONTRACTS().join()) return null;
    return g;
  } catch { return null; }
}
export const hasGrant = user => !!loadGrant(user);
export async function ensureGrant(user, signTyped) {
  const have = loadGrant(user); if (have) return have;
  const fhe = await getFhe();
  const kp = fhe.generateKeypair(), start = Math.floor(Date.now() / 1000);
  const typed = fhe.createEIP712(kp.publicKey, CONTRACTS(), start, DAYS);
  const signature = await signTyped(typed);
  const g = { publicKey: kp.publicKey, privateKey: kp.privateKey, signature, start, days: DAYS, contracts: CONTRACTS().join() };
  localStorage.setItem(grantKey(user), JSON.stringify(g));
  return g;
}
export const dropGrant = user => localStorage.removeItem(grantKey(user));

const ZERO = /^0x0+$/;
/** Decrypts handles `user` may read ([{ handle, contract }]); zero handles are 0. */
export async function userDecrypt(user, signTyped, items) {
  const live = items.filter(i => !ZERO.test(i.handle));
  const out = new Map();
  if (live.length) {
    const g = await ensureGrant(user, signTyped);
    const fhe = await getFhe();
    const res = await relayer(() => fhe.userDecrypt(live.map(i => ({ handle: i.handle, contractAddress: i.contract })),
      g.privateKey, g.publicKey, g.signature.replace('0x', ''), CONTRACTS(), user, g.start, g.days), 40_000, 'decryption');
    for (const i of live) out.set(i.handle, toBig(res[i.handle]));
  }
  return items.map(i => out.get(i.handle) ?? 0n);
}

/** Public decryption with the KMS proof. */
export async function publicDecrypt(handles) {
  const fhe = await getFhe();
  const res = await relayer(() => fhe.publicDecrypt(handles), 60_000, 'public decryption');
  return { values: handles.map(h => toBig(res.clearValues[h])), proof: res.decryptionProof };
}

function toBig(v) {
  if (v === undefined) throw new Error('missing decrypted value');
  return typeof v === 'boolean' ? (v ? 1n : 0n) : BigInt(v);
}
