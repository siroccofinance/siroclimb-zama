// FHE client: Zama's relayer SDK, loaded from Zama's CDN (window.relayerSDK).
//  - encryption of the player's inputs (side, stake) through the relayer, bound to the sender;
//  - user decryption of the player's own handles (balance, run value) with an EIP-712 grant the
//    wallet signs once a day (the keypair never leaves this browser);
//  - public decryption (round standings, published runs) with the KMS proof the contract checks.
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
/** Starts loading the SDK and its WASM in the background (first encryption is then instant). */
export const warmUp = () => getFhe().catch(() => {});

const hex = b => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** Encrypts a run's side (ebool) and optionally its stake (euint64, 6 decimals) for `sender`. */
export async function encryptRun(sender, long, stakeUnits) {
  const input = (await getFhe()).createEncryptedInput(ADDR.Siroclimb, sender);
  input.addBool(long);
  if (stakeUnits != null) input.add64(BigInt(stakeUnits));
  const enc = await input.encrypt();
  return { handles: enc.handles.map(hex), proof: hex(enc.inputProof) };
}

// ── user decryption grant (one wallet signature per day, kept in this tab's local storage)
const DAYS = 1;
const grantKey = user => `siroclimb:fhe-grant:${user.toLowerCase()}`;
const CONTRACTS = () => [ADDR.Siroclimb, ADDR.StakeToken];
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
    const res = await (await getFhe()).userDecrypt(live.map(i => ({ handle: i.handle, contractAddress: i.contract })),
      g.privateKey, g.publicKey, g.signature.replace('0x', ''), CONTRACTS(), user, g.start, g.days);
    for (const i of live) out.set(i.handle, toBig(res[i.handle]));
  }
  return items.map(i => out.get(i.handle) ?? 0n);
}

/** Public decryption with the KMS proof. */
export async function publicDecrypt(handles) {
  const res = await (await getFhe()).publicDecrypt(handles);
  return { values: handles.map(h => toBig(res.clearValues[h])), proof: res.decryptionProof };
}

function toBig(v) {
  if (v === undefined) throw new Error('missing decrypted value');
  return typeof v === 'boolean' ? (v ? 1n : 0n) : BigInt(v);
}
