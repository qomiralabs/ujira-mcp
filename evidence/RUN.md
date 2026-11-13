# Testnet run

Mandate [CDEEDQ64YS6XHBTWC3QLS5JWOLI3LSO46VDDZE66FW6CZGHZNRDV4GZW](https://stellar.expert/explorer/testnet/contract/CDEEDQ64YS6XHBTWC3QLS5JWOLI3LSO46VDDZE66FW6CZGHZNRDV4GZW) on Stellar testnet, written 2026-11-13T11:03:07.062Z.
Amounts are USDC (7 decimals); the raw integer minor units are in testnet-run.json.
Blocked payouts send nothing: the engine asks the mandate by simulation, and the reason is the contract's own error.
Verified means the receipt matches the payout record on the mandate and every listed transaction succeeded on the ledger.

| # | Task | Rail | Recipient | Amount | Outcome | Reason | Request tx | Approve tx | Payment tx | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | demo-20261113T1101-01 | usdc | GDWQ...FPLX | 5 USDC | paid |  | [12409b92](https://stellar.expert/explorer/testnet/tx/12409b924b64ac4fff955461fa13b36ce22c540282c1af2a163f3c00e6a0f9b9) |  | [51b33498](https://stellar.expert/explorer/testnet/tx/51b33498da3b4d2896c62a41eaaec94b5affdb859f2d17ae556cbbb6094ae587) | yes |
| 2 | demo-20261113T1101-02 | usdc | GD3G...XRQ3 | 7.5 USDC | paid |  | [21dd7cc6](https://stellar.expert/explorer/testnet/tx/21dd7cc68251706f5c96bc6a3fdb2eecd8b44bbf8e3e4b36c85608a27b7f77fd) |  | [c9a69b3c](https://stellar.expert/explorer/testnet/tx/c9a69b3cd00e529227bc7b0d5f2a8a31e7d19b534835dad0e4c6c13d65b10c73) | yes |
| 3 | demo-20261113T1101-03 | usdc | GCF3...CUK6 | 3 USDC | paid |  | [42d84a9d](https://stellar.expert/explorer/testnet/tx/42d84a9db757220905148faff7766dda36886d7f013bbfab5943f19dbbc509a4) |  | [464d943a](https://stellar.expert/explorer/testnet/tx/464d943a53043a748ea9e93096c60b787571dfacd262bc534937e6a1317007a4) | yes |
| 4 | demo-20261113T1101-04 | usdc | GDWQ...FPLX | 2.5 USDC | paid |  | [965d6fd1](https://stellar.expert/explorer/testnet/tx/965d6fd1fc7b8b24fe8a30896de2e9624cecf3cd94db31fde0b0b3bd3f3d0448) |  | [5518d705](https://stellar.expert/explorer/testnet/tx/5518d7053e76ab08ba37121a43bf3f55fe497ec74d9c13874f357ba618adda3e) | yes |
| 5 | demo-20261113T1101-05 | usdc | GD3G...XRQ3 | 60 USDC | blocked | payment_cap_exceeded |  |  |  | yes |
| 6 | demo-20261113T1101-06 | usdc | GD45...PBS2 | 1 USDC | blocked | recipient_not_allowed |  |  |  | yes |
| 7 | demo-20261113T1101-07 | usdc | GCF3...CUK6 | 22 USDC | approved_then_paid |  | [fc9e88f9](https://stellar.expert/explorer/testnet/tx/fc9e88f9b24239dfe74d5a8308bc73a290c629b6582303b0b21331f8c1bb2fe5) | [27507727](https://stellar.expert/explorer/testnet/tx/275077272a15c318ee26b37d976511eb34b37e68bfbc67c27d3b7f5be6baf37b) | [1f9f14ac](https://stellar.expert/explorer/testnet/tx/1f9f14ac086c81509c2b6e9533879b61577ad6d68a4925a2e6e0b6a87b6a707d) | yes |
| 8 | demo-20261113T1101-08 | usdc | GD3G...XRQ3 | 21 USDC | approved_then_paid |  | [32b12fa9](https://stellar.expert/explorer/testnet/tx/32b12fa9a887889655341dd817679db74168e8b43cad4b179ce461083a8c6e3d) | [26c1fd7e](https://stellar.expert/explorer/testnet/tx/26c1fd7e46039ba4686949dfbeed2c6f00e1e14221757d459f7734f87e11381d) | [b5fa2df2](https://stellar.expert/explorer/testnet/tx/b5fa2df2283c7ca4907e9be794467e568959c5f0d1cda0164784ac8e5c2b7904) | yes |
| 9 | demo-20261113T1101-09 | usdc | GDWQ...FPLX | 19 USDC | paid |  | [bcacc762](https://stellar.expert/explorer/testnet/tx/bcacc762a1259d004fa8af094d5a257f3a91c5c9c197566c3ce271ddd9bbcc41) |  | [2528fdb5](https://stellar.expert/explorer/testnet/tx/2528fdb5e684185c036e2aabf5c4cdd917ccb5186bfca4426c5ecf43683b2336) | yes |
| 10 | demo-20261113T1101-10 | usdc | GDWQ...FPLX | 19 USDC | paid |  | [98890117](https://stellar.expert/explorer/testnet/tx/98890117dbd78945a49c8cd924c6ab750d3da7bf41a35f13a6877d58d32f9ec5) |  | [8457409a](https://stellar.expert/explorer/testnet/tx/8457409ad600b2c28eccccd67ae0a309a0e46b461e262ccd007bcc0424736bd8) | yes |
| 11 | demo-20261113T1101-11 | usdc | GDWQ...FPLX | 5.5 USDC | paid |  | [b835e247](https://stellar.expert/explorer/testnet/tx/b835e247a82111e90873ac26999705dd1f529758a910563860a093a97569eb16) |  | [9804af1e](https://stellar.expert/explorer/testnet/tx/9804af1e8016519c1534b14fe30121811d4de4d66717a881f8604957c817bb5c) | yes |
| 12 | demo-20261113T1101-12 | usdc | GDWQ...FPLX | 50 USDC | blocked | daily_cap_exceeded |  |  |  | yes |

## SDP rail

Through the same mandate, paid by the Stellar Disbursement Platform running locally on testnet (setup in [docs/sdp-testnet.md](../docs/sdp-testnet.md)). The mandate pays the SDP distribution account [GBOO...GEKW](https://stellar.expert/explorer/testnet/account/GBOORJU2KRZUIV7RDAGM3U4JRO6S7N5SSKG7SW7HDNKFXAY7225RGEKW), then SDP pays the person, so each payout has two payment transactions. Written by `examples/sdp-payouts.ts`.

| # | Task | Recipient | Amount | Outcome | Request tx | Mandate to SDP tx | SDP to recipient tx | SDP disbursement | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 13 | sdp-demo-2026-11-13-1 | GDWQ...FPLX | 2 USDC | paid | [1c284852](https://stellar.expert/explorer/testnet/tx/1c2848525a714e1f8bb7cebb0907cd986727c0b3c41b0435542880a583f892f3) | [081ec1b4](https://stellar.expert/explorer/testnet/tx/081ec1b4d9dcc16bf63aadca07877bddd1d36fc501eb5003809ad403e4699908) | [c53f6cc7](https://stellar.expert/explorer/testnet/tx/c53f6cc7f603497ba460f985549bde86e9879674cd7b50d6ffd6b3bc19466d49) | 5d0e6f64-10f7-4214-8c94-30d841837e59 | yes |
| 14 | sdp-demo-2026-11-13-2 | GD3G...XRQ3 | 3 USDC | paid | [bf8b6616](https://stellar.expert/explorer/testnet/tx/bf8b661631dec83a1922ad3a20a8badc01b85f7fc38b4583ee31145e6445ff04) | [1e70716b](https://stellar.expert/explorer/testnet/tx/1e70716b7668f98a17dbe9a0df449eaae388f401468730b6bbb69ec23081e941) | [db834e5f](https://stellar.expert/explorer/testnet/tx/db834e5f3cdedcc4752f1e129e5dbe32ce82c382c3d082cb6155cc4948ec9c03) | cbd517c4-5a66-4b83-b8aa-e7a62dac6b3f | yes |
