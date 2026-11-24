// One user decryption in its own process: reads { key, items: [{ handle, contract }] } on stdin,
// prints the clear values. Used by lib.userDecrypt so a wedged relayer connection in a long-running
// battery never blocks other decryptions (F33).
import { Wallet } from 'ethers';
import { ADDR, RPC_URL } from './lib.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { key, items } = JSON.parse(input);
const { createInstance, SepoliaConfig } = await import('@zama-fhe/relayer-sdk/node');
const f = await createInstance({ ...SepoliaConfig, network: RPC_URL });
const wallet = new Wallet(key);
const kp = f.generateKeypair(), start = Math.floor(Date.now() / 1000), contracts = [ADDR.Siroclimb, ADDR.StakeToken];
const t = f.createEIP712(kp.publicKey, contracts, start, 1);
const types = { ...t.types }; delete types.EIP712Domain;
const sig = await wallet.signTypedData(t.domain, types, t.message);
const res = await f.userDecrypt(items.map(i => ({ handle: i.handle, contractAddress: i.contract })), kp.privateKey, kp.publicKey, sig.replace('0x', ''), contracts, wallet.address, start, 1);
process.stdout.write(JSON.stringify(items.map(i => String(res[i.handle]))));
process.exit(0);
