# Program keypair setup

The old placeholder ID was invalid Base58. A temporary valid ID is set:
`81JkoiKhkG7UqyA1ubgZKjhEWNXZtVakSxDx4nfUWx8q`

**Before deploy, generate your own keypair** (recommended):

```bash
cd prestocks-lend
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase -o target/deploy/prestocks_lend-keypair.json --force
solana-keygen pubkey target/deploy/prestocks_lend-keypair.json
```

Then put that pubkey in:
1. `programs/prestocks-lend/src/lib.rs` → `declare_id!("...");`
2. `Anchor.toml` → all `prestocks_lend = "..."` entries
3. `src/lib/constants.ts` → `PROGRAM_ID`

Then:
```bash
anchor build
anchor deploy
```
