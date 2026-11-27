# Runbook: the key encryption key

`UJIRA_KEY_ENCRYPTION_KEY` seals every project's agent secret (`ujira.agent_keys`) and every recipient email (`ujira.recipient_pii`) with AES-256-GCM. Each sealed value is bound to its tenant and its row through the associated data, so a value moved to another row does not open. The key lives only in the host's environment. It is never in the repository, the database, a log line or an error message.

Rotation is documented here and not built yet. The steps marked **to build** are the work to do before the first rotation, which is due before mainnet or at once if the key may have leaked.

## The value

- 32 random bytes, standard base64 with padding: 44 characters ending in `=`.
- Make one with `openssl rand -base64 32`. Paste it without a trailing newline: the server refuses anything that is not exactly 32 bytes and says so without repeating the value.
- One key per environment. Testnet and mainnet never share one.
- Keep a second copy offline, held by two people. Losing the key loses every agent secret and every email sealed under it (see "If the key is lost").

## When it is required

The web role refuses to start with `UJIRA_SIGN_IN=on` and no key, because signed in people make projects and every project gets an agent key. A malformed key refuses to start whatever else is set, so a bad value fails the deploy instead of the first project.

## Planned rotation

Rotation re-seals every value under a new key while both keys are loaded, so nothing stops working at any point.

1. **To build:** a `kek_version` column on `agent_keys` and `recipient_pii`, set on every seal, so a query can count what is still under the old key.
2. **To build:** `UJIRA_KEY_ENCRYPTION_KEY_PREVIOUS`. When it is set the sealer opens with the current key first and then the previous one, and always seals with the current one.
3. **To build:** a re-seal job that walks each project in its own tenant transaction, as the worker, opens each value under the previous key and seals it again under the current one with the same associated data. It is idempotent (rows already on the current version are skipped), has `--dry-run`, and prints counts per table.
4. Make the new key and store it in the host's secrets and in the offline copy.
5. Deploy with `UJIRA_KEY_ENCRYPTION_KEY` set to the new key and `UJIRA_KEY_ENCRYPTION_KEY_PREVIOUS` set to the old one. Check that payouts still sign and that the dashboard still shows recipient emails.
6. Run the re-seal job, with `--dry-run` first. Then check that no row is left on the old version.
7. Deploy without `UJIRA_KEY_ENCRYPTION_KEY_PREVIOUS`, and check again that payouts sign and emails show.
8. Database backups still hold values sealed under the old key. Keep the old key in the offline copy until the last backup made before step 6 has expired (30 days), then destroy it.

## If the key may have leaked

The key alone opens nothing: someone would also need the sealed rows, which means database access or a backup. Treat it as urgent anyway, and assume both have leaked until it is clear that only one has.

1. Ask the principals to pause their mandates. A paused mandate refuses every payout request, whoever signs it, and only the principal's wallet can pause.
2. Rotate as above. Until the rotation tooling exists, the testnet path is:
   - set a new key;
   - retire each project's agent key and provision a new one, which also gets a funded account;
   - have each principal create a new mandate that names the new agent key, then move their funds across with the existing `withdraw` and `fund` actions.

   Mandates name their agent on chain, so a new key does not help a mandate that still names the old one. That is why each principal makes a new mandate.

3. Record what happened as a security event, and say what was exposed and for how long.

## If the key is lost

Nothing sealed under it can be opened again. That is by design, and there is no way around it.

- Agent keys: set a new key, retire and provision every project's agent key, and have principals point new mandates at them, as in step 2 above. No money is at risk, because the funds sit in the mandate contracts and the principal's wallet controls them.
- Recipient emails: gone. Recipients add them again through onboarding.

## Before mainnet

The plan is to keep the key in a KMS rather than in the environment, with a data key per subject wrapped by the KMS key. Rotation then re-wraps the data keys only, and erasing a person destroys their data key. That replaces this runbook's steps 1 to 3.
