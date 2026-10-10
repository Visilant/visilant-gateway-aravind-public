import { diagnosticSpan } from '../diagnostics';
import { execFile } from 'child_process';
import { Inject, Service } from 'typedi';
import { promisify } from 'util';
import type { DicomNodeConfig } from '../../config';
import { LOGGER } from '../../tokens';
import type { Logger } from '../logger';
import { BIN, ECHO_TIMEOUT_MS, MAX_OUTPUT_BYTES } from './dicom.constants';

const execFileAsync = promisify(execFile);

// The binary is missing or its installation is broken: a fault on this box, never the input's.
export class ToolMissingError extends Error {}

// Adapter over the DCMTK CLIs. No business logic — it performs transfers and reports
// what the tools said.
@Service()
export class DicomClient {
    protected readonly logger: Logger;

    constructor(@Inject(LOGGER) logger: Logger) {
        this.logger = logger;
    }

    // C-ECHO, the DICOM "ping". Throws if the node is unreachable or rejects the
    // association.
    async echo(node: DicomNodeConfig): Promise<void> {
        await this.run(
            BIN.echoscu,
            [node.host, String(node.port), '-aec', node.called_ae, '-aet', node.calling_ae],
            'C-ECHO',
            ECHO_TIMEOUT_MS
        );
    }

    // Runs a CLI and normalizes failure.
    //
    // Never log err.message or the argument list: img2dcm's `-k` keys carry PHI, and
    // execFile puts the whole argv into the error message. Only the tool's own stderr
    // (connection and transfer-syntax messages) and the exit code are safe to surface.
    protected async run(bin: string, args: string[], step: string, timeoutMs: number, maxBuffer = MAX_OUTPUT_BYTES): Promise<string> {
        try {
            const { stdout } = await diagnosticSpan(`subprocess.${step === 'JPEG normalise' ? 'jpeg_normalize' : step.startsWith('C-FIND') ? 'findscu' : step}`, () => execFileAsync(bin, args, {
                timeout: timeoutMs,
                maxBuffer,
            }));
            return stdout;
        } catch (err: unknown) {
            const detail = describeFailure(err, bin, timeoutMs);
            this.logger.error(`DICOM ${step} failed: ${detail}`);
            const Failure = (err as { code?: unknown }).code === 'ENOENT' ? ToolMissingError : Error;
            throw new Failure(`DICOM ${step} failed: ${detail}`);
        }
    }
}

// Turns a child_process failure into something an operator can act on.
//
// The two most likely failures on this deployment both arrive with an empty stderr and
// no exit code, so reporting only `exited with code ${code}` yields "exited with code
// unknown" for the unreachable-PACS case — the single most common thing that goes wrong.
// Timeout and missing-binary are therefore named explicitly.
export function describeFailure(err: unknown, bin: string, timeoutMs: number): string {
    const e = err as { stderr?: string; code?: number | string | null; killed?: boolean; signal?: string };

    if (e.code === 'ENOENT') {
        return `${bin} not found. Install it (DCMTK, or ImageMagick for magick), or point the matching *_BIN environment variable at it.`;
    }
    if (e.killed || e.signal === 'SIGTERM') {
        return `timed out after ${Math.round(timeoutMs / 1000)}s. The host is unreachable, or the association was never accepted.`;
    }

    const stderr = (e.stderr || '').toString().trim();
    if (stderr) return stderr;

    return e.code === null || e.code === undefined ? 'the tool exited without a status' : `exited with code ${e.code}`;
}
