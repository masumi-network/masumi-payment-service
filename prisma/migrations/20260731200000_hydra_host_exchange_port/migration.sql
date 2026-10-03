-- Hydra: the Exchange Plane port belongs to the Host that serves it.
--
-- An invite carries the URL its redemption must be sent to, and that URL was
-- built from a single service-wide setting rather than from the Host the invite
-- was actually provisioned on. With one Host per service the two agree by
-- accident; with two, an invite issued on Host B advertises Host A's exchange,
-- the redemption lands on a Host that never saw the nonce, and the counterparty
-- is told 404 for something they did nothing wrong with.
--
-- Nullable because the value comes from the Host itself, via capabilities: it
-- is unknown until the first probe, and a Host that predates this simply
-- reports it on the next refresh.

ALTER TABLE "HydraHost" ADD COLUMN "exchangePort" INTEGER;
