# Deployments

`pnpm deploy:cascade` writes `<network>.json` here (contract and service account ids, code hashes, transaction hashes; never keys) and `pnpm spike` appends results to `<network>-spikes.json`. Both are public information and meant to be committed. The server reads its contract ids from `<network>.json`.
