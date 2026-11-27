// Encryption of the player's inputs off the main thread. Building an encrypted input with its zero-knowledge
// proof takes ~3.5 s of CPU in Zama's relayer SDK; on the page's thread that froze the 3D scene (the intro,
// the lobby after every pick, the climb's first seconds). Here it runs in a worker: the scene keeps 60 fps.
// Classic worker: the SDK is Zama's UMD build (it sets self.relayerSDK). Its CDN serves it as
// application/node, which importScripts refuses, so it is fetched and loaded from a blob of the same bytes.
self.window = self;
let ready = null;

function init(url, rpc) {
  ready ||= (async () => {
    const src = await (await fetch(url)).text();
    importScripts(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    await self.relayerSDK.initSDK();
    return self.relayerSDK.createInstance({ ...self.relayerSDK.SepoliaConfig, network: rpc });
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// { contract, user, bool?, u64? } → { handles: Uint8Array[], inputProof: Uint8Array }
async function encrypt({ contract, user, bool, u64 }) {
  const fhe = await ready;
  const input = fhe.createEncryptedInput(contract, user);
  if (bool != null) input.addBool(bool);
  if (u64 != null) input.add64(BigInt(u64));
  const enc = await input.encrypt();
  return { handles: enc.handles, inputProof: enc.inputProof };
}

self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    const v = op === 'init' ? (await init(args.url, args.rpc), true) : await encrypt(args);
    self.postMessage({ id, ok: true, v });
  } catch (e) {
    self.postMessage({ id, ok: false, err: String((e && e.message) || e).slice(0, 300) });
  }
};
