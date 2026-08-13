use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{PolicyId}
use cardano/address.{Credential}
use cardano/transaction.{OutputReference, Transaction}
use smart_wallet/mint
use smart_wallet/spend
use smart_wallet/types.{
  Action, AgentSpend, Datum, Deposit, OwnerSpend, UpdatePolicy,
}

/// A treasury the payment service's hot key can spend from, under a ceiling,
/// and only with an external quorum's co-signature.
///
/// The wallet is one UTxO carrying the funds, a state token, and the dynamic
/// configuration in its datum. This validator is also that token's minting
/// policy, so its script hash is the policy id, the address's payment
/// credential, and the wallet's identity all at once.
///
/// Parameters are immutable and part of the address: changing any of them
/// means a different wallet, not a modified one. Only the datum — the agent
/// key, the budget and the counters — can be rewritten in place, by the owner.
validator smart_wallet(
  /// Cold key. Spends without restriction, rewrites the configuration, retires
  /// the wallet. Never subject to the quorum.
  owner: VerificationKeyHash,
  /// External co-signers. A key listed twice carries two votes.
  quorum_vks: List<VerificationKeyHash>,
  /// Weighted votes required on every agent spend.
  ///
  /// Deliberately unguarded on-chain. A threshold of zero or below disables
  /// the quorum **permanently at this address**, leaving the hot key bounded
  /// only by the ceiling, with no recovery short of standing up a new wallet.
  /// A threshold above the achievable weight is the milder mistake: the agent
  /// path is dead on arrival but `OwnerSpend` still sweeps the funds. Deploy
  /// tooling must check both.
  quorum_threshold: Int,
  /// Stake credential of the wallet's address, or `None` for an enterprise
  /// address. The spend path pins the continuing output to the full address, so
  /// this is frozen for the wallet's life; naming it here means the address is
  /// fully determined by the parameters and the creating transaction cannot
  /// pick a different one.
  stake: Option<Credential>,
) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    mint.mint_is_valid(owner, stake, policy_id, self)
  }

  spend(
    datum: Option<Datum>,
    redeemer: Action,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    when redeemer is {
      // Deliberately does not read the datum: this is also how the owner
      // rescues a UTxO parked at the address without a usable one.
      OwnerSpend -> spend.owner_signed(owner, self)
      UpdatePolicy -> spend.update_is_valid(owner, own_ref, self)
      AgentSpend -> {
        expect Some(wallet_datum) = datum
        spend.agent_spend_is_valid(
          wallet_datum,
          quorum_vks,
          quorum_threshold,
          own_ref,
          self,
        )
      }
      Deposit -> {
        expect Some(wallet_datum) = datum
        spend.deposit_is_valid(wallet_datum, owner, own_ref, self)
      }
    }
  }

  else(_) {
    fail
  }
}
