// Counts requests per key in fixed windows, in memory. A restart forgets the counts,
// which only makes the limit briefly looser.
export class FixedWindowLimiter {
    private readonly windows = new Map<string, { start: number; count: number }>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        // Monotonic, so a wall clock set back cannot lock a client out.
        private readonly now: () => number = () => performance.now(),
    ) {}

    get size(): number {
        return this.windows.size;
    }

    take(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
        const now = this.now();
        this.forgetExpired(now);
        let window = this.windows.get(key);
        if (!window || now - window.start >= this.windowMs) {
            window = { start: now, count: 0 };
            // Re-insert, so the map stays in window-start order.
            this.windows.delete(key);
            this.windows.set(key, window);
        }
        if (window.count >= this.limit) {
            return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000)) };
        }
        window.count += 1;
        return { allowed: true };
    }

    // Insertion order is start order for live windows, so the scan stops at the first
    // window still open.
    private forgetExpired(now: number): void {
        for (const [key, window] of this.windows) {
            if (now - window.start < this.windowMs) break;
            this.windows.delete(key);
        }
    }
}
