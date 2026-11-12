// How the gateway is asked to stop cleanly.
//
// On Windows a signal from the launcher does not arrive: child.kill() is TerminateProcess,
// and no handler runs. So the launcher sends SHUTDOWN_MESSAGE over the IPC channel it
// already has. SIGTERM and SIGINT still work where they exist (a terminal, Linux, the
// tests). When the launcher itself goes away, the gateway stops too, cleanly, so a
// restarted launcher never finds a second queue worker running.
export const SHUTDOWN_MESSAGE = { type: 'gateway.shutdown' } as const;

export type ShutdownReason = 'launcher' | 'launcher_gone' | 'SIGTERM' | 'SIGINT';

export function onShutdownRequest(handler: (reason: ShutdownReason) => void, proc: NodeJS.Process = process): void {
    let requested = false;
    const request = (reason: ShutdownReason) => {
        if (requested) return;
        requested = true;
        handler(reason);
    };
    proc.on('SIGTERM', () => request('SIGTERM'));
    proc.on('SIGINT', () => request('SIGINT'));
    proc.on('message', (message: unknown) => {
        if ((message as { type?: unknown } | null)?.type === SHUTDOWN_MESSAGE.type) request('launcher');
    });
    proc.once('disconnect', () => request('launcher_gone'));
}
