// One relayer request in its own process, so a wedged relayer connection in a long-running battery
// never blocks the others (F33, F40). Reads JSON on stdin:
//   { key, items: [{ handle, contract }] }        -> user decryption, prints the clear values
//   { encrypt: { sender, long, stake? } }          -> input encryption, prints { handles, proof }
import { Wallet } from 'ethers';
import { ADDR, RPC_URL } from './lib.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { key, items, encrypt } = JSON.parse(input);
const { createInstance, SepoliaConfig } = await import('@zama-fhe/relayer-sdk/node');
const f = await createInstance({ ...SepoliaConfig, network: RPC_URL });
if (encrypt) {
  const hex = b => '0x' + Buffer.from(b).toString('hex');
  const inp = f.createEncryptedInput(ADDR.Siroclimb, encrypt.sender);
  inp.addBool(encrypt.long);
  if (encrypt.stake != null) inp.add64(BigInt(encrypt.stake));
  const enc = await inp.encrypt();
  process.stdout.write(JSON.stringify({ handles: enc.handles.map(hex), proof: hex(enc.inputProof) }));
  process.exit(0);
}
const wallet = new Wallet(key);
const kp = f.generateKeypair(), start = Math.floor(Date.now() / 1000), contracts = [ADDR.Siroclimb, ADDR.StakeToken];
const t = f.createEIP712(kp.publicKey, contracts, start, 1);
const types = { ...t.types }; delete types.EIP712Domain;
const sig = await wallet.signTypedData(t.domain, types, t.message);
const res = await f.userDecrypt(items.map(i => ({ handle: i.handle, contractAddress: i.contract })), kp.privateKey, kp.publicKey, sig.replace('0x', ''), contracts, wallet.address, start, 1);
process.stdout.write(JSON.stringify(items.map(i => String(res[i.handle]))));
process.exit(0);
