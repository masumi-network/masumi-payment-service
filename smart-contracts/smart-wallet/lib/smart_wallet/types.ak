use aiken/crypto.{VerificationKeyHash}

/// POSIX time in **milliseconds**, matching the unit of
/// `Transaction.validity_range`.
pub type POSIXTime =
  Int

/// Asset quantities as they appear in a **datum**.
///
/// Deliberately `Pairs` rather than stdlib's `Value`. `Value` is a
/// `Dict`-backed type whose canonical ordering is an invariant maintained by
/// its *constructors*; casting datum bytes with `expect limit: Value = raw`
/// checks only the structural shape, never the ordering. Since the transaction
/// that funds a wallet runs no script, a datum can arrive with duplicate or
/// misordered entries, and `dict.get` would then return whichever entry its
/// ordering assumption reaches first.
///
/// `vested_pay.ak` declares the same type for the same reason on
/// redeemer-supplied amounts. Lookups here fail closed on duplicates instead of
/// trusting an ordering nobody enforced — see `smart_wallet/asset_value`.
pub type AssetValue =
  Pairs<ByteArray, Pairs<ByteArray, Int>>

/// Inline datum of the single wallet UTxO — the one carrying the state token.
///
/// `limit` and `spent_in_period` must list exactly the same assets in the same
/// order. The spend path enforces it, which is what makes the counter update a
/// deterministic map rather than an insertion with an ordering question.
pub type Datum {
  /// The delegated hot key. One agent per wallet; a second agent means a
  /// second wallet. Lives here rather than in the parameters so a compromised
  /// hot key can be rotated without changing the address.
  agent: VerificationKeyHash,
  /// Maximum each asset may move out per period. An asset absent from this
  /// list is frozen: it can neither leave nor be added.
  ///
  /// **Lovelace must be listed** — policy `#""`, name `#""` — or the wallet is
  /// unusable: a spend moves lovelace even when it only pays the fee, and a
  /// deposit of ADA is a movement of an unlisted asset. Nothing on-chain checks
  /// this, by the same decision that leaves the quorum configuration
  /// unguarded; deployment tooling owns it.
  limit: AssetValue,
  /// Length of the accounting window, in milliseconds.
  period_length: Int,
  /// Start of the window `spent_in_period` is accounted against.
  period_start: POSIXTime,
  /// Moved out so far inside the current window, per asset.
  spent_in_period: AssetValue,
  /// Lovelace floor an agent spend may not breach, so the wallet keeps a
  /// reserve and the UTxO stays above the ledger's minimum. The owner is not
  /// bound by it.
  min_balance_lovelace: Int,
}

pub type Action {
  /// Move value out, within the ceiling. Needs the agent **and** the quorum.
  AgentSpend
  /// Move value in. Nothing may leave. Agent **or** owner.
  Deposit
  /// Rewrite the dynamic configuration, keeping the wallet alive. Owner only.
  UpdatePolicy
  /// Unrestricted: sweep, retire, or rescue a malformed UTxO. Owner only.
  OwnerSpend
}
