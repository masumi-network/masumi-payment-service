/**
 * Binds an invite preview to the exact code it was read from.
 *
 * The code field stays editable while a preview request is in flight. Without
 * this gate, the response for code A could land after the operator had typed
 * code B, so the dialog would show A's terms and then redeem B. Each request
 * takes a ticket; any edit, close, or newer request invalidates older tickets,
 * and a response is shown only while its ticket is still current. Redeem
 * submits `acceptedCodeForIssuer()`, which also requires the independently
 * obtained issuer address to match the signed invite.
 */
export type InvitePreviewTicket = { id: number; code: string };

export function createInvitePreviewGate() {
  let current = 0;
  let accepted: string | null = null;
  let expectedIssuerAddress: string | null = null;
  return {
    begin(code: string): InvitePreviewTicket {
      current += 1;
      accepted = null;
      expectedIssuerAddress = null;
      return { id: current, code };
    },
    invalidate(): void {
      current += 1;
      accepted = null;
      expectedIssuerAddress = null;
    },
    /** Take a response's code as the one to redeem. False when the ticket is stale. */
    accept(ticket: InvitePreviewTicket): boolean {
      if (ticket.id !== current) return false;
      accepted = ticket.code;
      expectedIssuerAddress = null;
      return true;
    },
    isCurrent(ticket: InvitePreviewTicket): boolean {
      return ticket.id === current;
    },
    /** An expected address only applies to the invite currently on screen. */
    setExpectedIssuerAddress(walletAddress: string): void {
      expectedIssuerAddress = accepted === null ? null : walletAddress.trim();
    },
    /** Refuse a redeem code unless the independently obtained address matches. */
    acceptedCodeForIssuer(walletAddress: string): string | null {
      return accepted !== null &&
        walletAddress.length > 0 &&
        expectedIssuerAddress === walletAddress
        ? accepted
        : null;
    },
  };
}
