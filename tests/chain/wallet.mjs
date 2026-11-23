// Test wallet for the real front: an EIP-1193 provider injected into the page whose requests are
// answered in Node by an ethers Wallet (signing) and the Sepolia RPC (everything else), the way
// MetaMask would. Never used outside tests; the key comes from the caller.
import { JsonRpcProvider, Wallet, getBytes, toUtf8String, isHexString } from 'ethers';

export const RPC = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

export async function injectWallet(page, key) {
  const provider = new JsonRpcProvider(RPC, 11155111, { staticNetwork: true, batchMaxCount: 1 });
  const w = new Wallet(key, provider);
  const log = [];
  await page.exposeFunction('__scWallet', async (method, params = []) => {
    try {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [w.address];
        case 'eth_chainId': return '0xaa36a7';
        case 'net_version': return '11155111';
        case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain': return null;
        case 'personal_sign': { const m = params[0]; return await w.signMessage(isHexString(m) ? getBytes(m) : m); }
        case 'eth_signTypedData_v4': {
          const t = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
          const types = { ...t.types }; delete types.EIP712Domain;
          log.push('signTypedData');
          return await w.signTypedData(t.domain, types, t.message);
        }
        case 'eth_sendTransaction': {
          const tx = params[0];
          const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, gasLimit: tx.gas ? BigInt(tx.gas) : undefined });
          log.push(`tx ${sent.hash}`);
          return sent.hash;
        }
        default: return await provider.send(method, params);
      }
    } catch (e) { return { __error: { message: e.shortMessage || e.message, code: e.code === 'ACTION_REJECTED' ? 4001 : -32000, data: e.data } }; }
  });
  await page.evaluateOnNewDocument(() => {
    const listeners = {};
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => { const r = await window.__scWallet(method, params); if (r && r.__error) { const e = new Error(r.__error.message); e.code = r.__error.code; e.data = r.__error.data; throw e; } return r; },
      on: (ev, cb) => { (listeners[ev] ||= []).push(cb); }, removeListener() {},
    };
  });
  return { address: w.address, wallet: w, log };
}
