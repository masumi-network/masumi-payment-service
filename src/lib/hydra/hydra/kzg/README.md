# Hydra KZG trusted setup

The eight `hydra-kzg-g1-*.ts` chunks contain the 4,096 compressed G1 monomial
points from Hydra 2.3.0's `hydra-plutus/trusted_setup.json`. Runtime verification
checks the concatenated 196,608 bytes against SHA-256
`08797579f6cfd5788eddc1a215d64dcfabd04acbcaf2953fb2c1afb830f43315`
before parsing a point.

The verifier accepts at most 4,095 TxOuts because a degree-4,095 accumulator
polynomial requires all 4,096 bundled monomial points.
