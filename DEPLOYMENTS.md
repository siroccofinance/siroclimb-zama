# Deployments

## Sepolia (chain id 11155111)

Sources are verified on [Sourcify](https://sourcify.dev) (`cd contracts && npm run verify:sourcify`).
The deployment records are in `contracts/deployments/sepolia/`, and the front reads its addresses
from `js/chain/deployments.json` (written by `npm run export -- sepolia`).
