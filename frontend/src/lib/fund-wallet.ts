/**
 * Client-side mirror of the server's minimum top-up floor
 * (`CONSTANTS.MIN_TOPUP_LOVELACE`, 5 ADA): each top-up is a single tx output,
 * so anything below Cardano's min-UTxO can never build, and the server 400s.
 * Mirrored here so the operator sees the error on the field before submitting
 * — on the setup form that submit includes their seed phrase.
 */
export const MIN_TOPUP_ADA = 5;
