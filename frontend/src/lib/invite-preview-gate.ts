/**
 * Binds an invite preview to the exact code it was read from.
 *
 * The code field stays editable while a preview request is in flight. Without
 * this gate, the response for code A could land after the operator had typed
 * code B, so the dialog would show A's terms and then redeem B. Each request
 * takes a ticket; any edit, close, or newer request invalidates older tickets,
 * and a response is shown only while its ticket is still current.
 */
export type InvitePreviewTicket = { id: number; code: string };

export function createInvitePreviewGate() {
  let current = 0;
  return {
    begin(code: string): InvitePreviewTicket {
      current += 1;
      return { id: current, code };
    },
    invalidate(): void {
      current += 1;
    },
    isCurrent(ticket: InvitePreviewTicket): boolean {
      return ticket.id === current;
    },
  };
}
