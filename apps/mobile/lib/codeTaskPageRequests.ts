export interface CodeTaskPageRequest { readonly more: boolean; }

/** Keep one pagination intent when a head refresh is already in flight. */
export class CodeTaskPageRequests {
  private current: CodeTaskPageRequest | null = null;
  private pendingMore = false;

  begin(more: boolean): CodeTaskPageRequest | null {
    if (this.current) {
      if (more && !this.current.more) this.pendingMore = true;
      return null;
    }
    const request = { more };
    this.current = request;
    return request;
  }

  /** A failed refresh drops queued pagination; the user can explicitly retry. */
  finish(request: CodeTaskPageRequest, succeeded: boolean, hasMore: boolean): boolean {
    if (request !== this.current) return false;
    const drain = succeeded && hasMore && this.pendingMore;
    this.current = null;
    this.pendingMore = false;
    return drain;
  }

  reset(): void {
    this.current = null;
    this.pendingMore = false;
  }
}
