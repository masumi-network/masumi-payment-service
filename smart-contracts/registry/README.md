# Masumi registry smart contract

Minting validators can be found in the `validators` folder, and supporting functions in the `lib` folder using `.ak` as a file extension.

## Building

Make sure to install aiken and have it available in your path
[Install Aiken](https://aiken-lang.org/installation-instructions#installation-instructions).

Now just run:

```sh
aiken build
```

To generate the smart contracts

## Running various scripts

To run the scripts you also need to install (Node.js)[https://nodejs.org/en/download/package-manager] and install the dependencies via `pnpm install`.

Afterwards you can run various scripts:

```sh
pnpm run generate-wallet
```

To generate a testnet wallet.

The address will be found in the `wallet.addr` and `wallet.sk` (private key) file. You can top-up some test ADA (here)[https://docs.cardano.org/cardano-testnets/tools/faucet/]

The following commands will require the `BLOCKFROST_API_KEY` environment variable to be set. Make sure to register an account on [Blockfrost](https://blockfrost.io/) and get your key for either the mainnet (not recommended) or preprod network and use it consistently.

```sh
pnpm run mint
```

To mint an example registry asset. The metadata can be configured in the `mint-example.mjs` file.

```sh
pnpm run defrag
```

To defrag the wallet (if there are no split up utxos containing only lovelace)

## Testing

You can add tests in any module using the `test` keyword. For example:

```aiken
test addition() {
  1 + 1 == 2
}
```

To run all tests, simply do:

```sh
aiken check
```

## Documentation

If you're writing a library, you might want to generate an HTML documentation for it.

Use:

```sh
aiken docs
```

## Resources

Find more on the [Aiken's user manual](https://aiken-lang.org).
