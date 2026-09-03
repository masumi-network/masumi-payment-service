use aiken/collection/list
use cardano/assets.{Value, flatten, quantity_of}
use smart_wallet/types.{AssetValue}

/// Quantity recorded for one asset, or `None` when the asset is absent.
///
/// Fails the script outright on a duplicate policy or asset name. A datum is
/// untrusted input — the funding transaction runs no script — so a repeated
/// entry is not a value to disambiguate, it is a malformed datum. Failing
/// closed turns it into a rejected spend rather than an ambiguity an attacker
/// picks the resolution of.
pub fn lookup(self: AssetValue, policy: ByteArray, name: ByteArray) -> Option<Int> {
  when list.filter(self, fn(Pair(candidate, _)) { candidate == policy }) is {
    [] -> None
    [Pair(_, names)] ->
      when list.filter(names, fn(Pair(candidate, _)) { candidate == name }) is {
        [] -> None
        [Pair(_, quantity)] -> Some(quantity)
        _ -> fail @"duplicate asset name in datum AssetValue"
      }
    _ -> fail @"duplicate policy id in datum AssetValue"
  }
}

pub fn is_listed(self: AssetValue, policy: ByteArray, name: ByteArray) -> Bool {
  when lookup(self, policy, name) is {
    Some(_) -> True
    None -> False
  }
}

/// Most distinct assets a wallet may budget.
///
/// A spend costs roughly (assets moved x assets listed), because every lookup
/// scans the list twice to detect duplicates. Without a bound, a large enough
/// datum pushes the wallet UTxO past the execution budget and the agent path
/// stops working.
///
/// Checked where the datum is *used* rather than where it is written, which is
/// what makes it complete: the transaction that funds a wallet runs no script,
/// so a cap enforced only on `UpdatePolicy` would miss a malformed initial
/// datum entirely. Enforced on the spend path, every datum that reaches a spend
/// has satisfied it.
pub const max_assets: Int = 16

/// True when the asset list is small enough to keep spends affordable.
pub fn is_bounded(self: AssetValue) -> Bool {
  list.length(keys(self)) <= max_assets
}

/// The (policy, name) sequence, in order.
fn keys(self: AssetValue) -> List<(ByteArray, ByteArray)> {
  list.flat_map(
    self,
    fn(Pair(policy, names)) {
      list.map(names, fn(Pair(name, _)) { (policy, name) })
    },
  )
}

/// True when two asset values list exactly the same assets in the same order.
///
/// Required between `limit` and `spent_in_period` so the counter update is a
/// map in place: no insertion, no ordering decision, and therefore no way for
/// two validators to disagree about what the updated datum should look like.
pub fn same_shape(left: AssetValue, right: AssetValue) -> Bool {
  keys(left) == keys(right)
}

/// Every quantity set to zero, preserving the shape. Used on roll-over.
pub fn zeroed(self: AssetValue) -> AssetValue {
  list.map(
    self,
    fn(Pair(policy, names)) {
      Pair(policy, list.map(names, fn(Pair(name, _)) { Pair(name, 0) }))
    },
  )
}

/// Add this transaction's outflow to each counter.
///
/// Only positive deltas are charged: a negative delta means value entered the
/// wallet, and letting that shrink a counter would buy back budget by
/// depositing.
pub fn charge(self: AssetValue, outflow: Value) -> AssetValue {
  list.map(
    self,
    fn(Pair(policy, names)) {
      Pair(
        policy,
        list.map(
          names,
          fn(Pair(name, spent)) {
            let delta = quantity_of(outflow, policy, name)
            Pair(
              name,
              if delta > 0 {
                spent + delta
              } else {
                spent
              },
            )
          },
        ),
      )
    },
  )
}

/// True when every counter is within its limit.
pub fn within_limit(spent: AssetValue, limit: AssetValue) -> Bool {
  list.all(
    spent,
    fn(Pair(policy, names)) {
      list.all(
        names,
        fn(Pair(name, quantity)) {
          when lookup(limit, policy, name) is {
            Some(allowed) -> quantity <= allowed
            None -> False
          }
        },
      )
    },
  )
}

/// True when every asset that moved has a limit entry.
///
/// `merge` prunes zero quantities, so `flatten` yields only assets whose
/// balance actually changed. An unlisted asset appearing here therefore moved,
/// which is exactly what the freeze forbids — in either direction. That single
/// rule is what keeps the state token in place and stops an NFT walking out
/// under a lovelace budget.
pub fn all_movements_listed(delta: Value, limit: AssetValue) -> Bool {
  list.all(
    flatten(delta),
    fn((policy, name, _quantity)) { is_listed(limit, policy, name) },
  )
}

/// True when a deposit actually deposits: at least one asset moved, every
/// asset that moved did so *into* the wallet, and each is listed.
///
/// The non-empty requirement is load-bearing rather than cosmetic. `merge`
/// prunes zero quantities, so a deposit that changes nothing flattens to `[]`,
/// and `list.all` is vacuously true on an empty list. Without this check the
/// holder of the agent key could consume and re-create the wallet UTxO
/// unchanged, over and over, for the price of a fee — invalidating every
/// in-flight transaction built against the previous UTxO and never settling.
///
/// That attack matters because `Deposit` deliberately needs no quorum: the
/// co-signers refusing to sign stops *spending*, not churning, so the only
/// other remedy is a cold-key agent rotation hours away. Requiring real value
/// to move raises the attacker's cost from a fee to a donation.
pub fn is_a_real_deposit(delta: Value, limit: AssetValue) -> Bool {
  let movements = flatten(delta)
  and {
    !list.is_empty(movements),
    list.all(
      movements,
      fn((policy, name, quantity)) {
        quantity > 0 && is_listed(limit, policy, name)
      },
    ),
  }
}
