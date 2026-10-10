import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import type { Logger } from '../../infrastructure/logger';
import { CONFIG, LOGGER } from '../../tokens';
import { CaptureStatus, ReleaseReason, ScreeningEntity } from '../../infrastructure/database/entities';
import { ScreeningCaptureRow, ScreeningRepository } from '../../infrastructure/database/repositories/ScreeningRepository';
import type { RegisterScreeningDto } from '../dto/screening.dto';
import type { WorklistEntryDto } from '../dto';
import { orderKey, sourceScope } from './screeningIdentity';

// Domain errors. The controllers map them to HTTP status codes.
export class ScreeningConflictError extends Error {}          // 409
export class ScreeningNotFoundError extends Error {}          // 404
export class CaptureScreeningMismatchError extends Error {}   // 400

export type ScreeningState = 'UPLOAD_PENDING' | 'AWAITING_PACS' | 'NEEDS_ATTENTION' | 'COMPLETED' | 'RELEASED';

// Who released a screening when nobody did: the inactivity backstop.
export const EXPIRY_ACTOR = 'system:expiry';
// Only these can expire. AWAITING_PACS has every image and is waiting on the archive.
const EXPIRABLE: readonly ScreeningState[] = ['UPLOAD_PENDING', 'NEEDS_ATTENTION'];
const DAY_MS = 86_400_000;
const RELEASED_MESSAGE = 'This screening was released at the gateway. Start a new screening for this order.';
const DELIVERED_MESSAGE = 'Screening is already delivered to PACS and cannot be released.';

// Released screenings are listed this long after release: long enough for a phone to
// learn of it (it keeps receipts 14 days), without the list growing forever.
const RELEASED_LISTED_DAYS = 30;

export interface ScreeningStatus {
    id: string;
    source_scope: string;
    order: { accession_number: string; study_instance_uid: string; step_id: string | null };
    state: ScreeningState;
    created_at: string;
    last_activity_at: string;
    completed_at: string | null;
    released_at: string | null;
    released_by: string | null;
    release_reason: ReleaseReason | null;
    captures: { capture_id: string; gateway_capture_id: string | null; status: string }[];
}

@Service()
export class ScreeningService {
    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly repository: ScreeningRepository,
    ) {}

    // screening_release: GET /screenings?view=all exists and can report RELEASED.
    capability() { return { screening_delivery: 1, screening_release: 1, source_scope: sourceScope(this.config) }; }

    async register(input: RegisterScreeningDto): Promise<ScreeningStatus> {
        const ids = JSON.stringify([...input.capture_ids].sort());

        // A retry of a manifest that is already registered is judged against the scope it
        // was registered under, so it still succeeds after the worklist source changed.
        const existing = await this.repository.find(input.id);
        if (existing) {
            if (!sameManifest(existing, input.source_scope, orderKey(input.source_scope, input.order), ids)) {
                throw new ScreeningConflictError('Screening manifest is immutable.');
            }
            // Same answer as an upload to it, so a phone that never learned of the release is told now.
            if (existing.released_at) throw new ScreeningConflictError(RELEASED_MESSAGE);
            return this.status(input.id);
        }

        const scope = sourceScope(this.config);
        if (input.source_scope !== scope) throw new ScreeningConflictError('Worklist source changed. Refresh before submitting.');
        const key = orderKey(scope, input.order);
        const now = new Date().toISOString();
        const row = Object.assign(new ScreeningEntity(), {
            id: input.id, source_scope: scope, order_key: key,
            accession_number: input.order.accession_number, study_instance_uid: input.order.study_instance_uid,
            step_id: input.order.step_id ?? null, capture_ids: ids, created_at: now, completed_at: null,
            last_activity_at: now, released_at: null, released_by: null, release_reason: null,
        });
        if (!await this.repository.insertIfMembersUnclaimed(row)) {
            const retry = await this.repository.find(input.id);
            if (retry && sameManifest(retry, scope, key, ids)) return this.status(input.id);
            const conflict = await this.repository.findOrder(key);
            throw new ScreeningConflictError(conflict ? `Order already submitted. Inspect screening ${conflict.id}.` : 'Capture identity is already in use.');
        }
        return this.status(input.id);
    }

    // Runs only for a capture the gateway has not accepted before; an idempotent replay is
    // answered by CaptureService before this is called.
    async validateCapture(screeningId: string | undefined, clientId: string | null, entry: WorklistEntryDto): Promise<void> {
        const declaredBy = clientId ? await this.repository.declaringScreening(clientId) : null;
        if (!screeningId) {
            if (declaredBy) throw new CaptureScreeningMismatchError('Capture requires its screening manifest.');
            return; // Legacy captures are accepted but can never complete an order.
        }
        const manifest = await this.repository.find(screeningId);
        if (!clientId || !manifest || declaredBy !== screeningId) {
            throw new CaptureScreeningMismatchError('Capture is not declared in this screening.');
        }
        if (manifest.released_at) {
            throw new ScreeningConflictError(RELEASED_MESSAGE);
        }
        // Compared in the manifest's own scope, not the current one: once a manifest is
        // registered its captures must be able to arrive even if the worklist source has
        // since been reconfigured. The entry's echoed source_scope is ignored.
        if (manifest.order_key !== orderKey(manifest.source_scope, entryOrder(entry))) {
            throw new CaptureScreeningMismatchError('Capture order does not match screening.');
        }
    }

    // Any registered manifest, whatever scope it was registered under: the ID is the
    // phone's own, and a phone must be able to follow a submission across a source change.
    async status(id: string): Promise<ScreeningStatus> {
        await this.reconcile();
        const manifest = await this.repository.find(id);
        if (!manifest) throw new ScreeningNotFoundError('Screening not found.');
        return this.statusOf(manifest);
    }

    private async statusOf(manifest: ScreeningEntity): Promise<ScreeningStatus> {
        return toStatus(manifest, groupByScreening(await this.repository.capturesOf([manifest.id])));
    }

    // For phones. Released screenings are left out unless asked for: phones built before
    // release existed reject a state they do not know.
    async list(includeReleased = false): Promise<ScreeningStatus[]> {
        await this.reconcile();
        return this.statuses(await this.repository.listByScope(sourceScope(this.config), includeReleased ? releasedCutoff() : undefined));
    }

    // For the operator page: everything not delivered, across every scope, so a screening
    // stuck before a worklist source change can still be released.
    async listUnfinished(): Promise<ScreeningStatus[]> {
        await this.reconcile();
        return this.statuses(await this.repository.listUnfinished(releasedCutoff()));
    }

    private async statuses(rows: ScreeningEntity[]): Promise<ScreeningStatus[]> {
        const captures = groupByScreening(await this.repository.capturesOf(rows.map(r => r.id)));
        return rows.map(row => toStatus(row, captures));
    }

    // Removes completed orders from a live worklist and annotates the rest with their
    // submission status. A failure here fails the refresh closed rather than returning
    // the unfiltered list.
    async filter(entries: WorklistEntryDto[]): Promise<WorklistEntryDto[]> {
        await this.reconcile();
        const scope = sourceScope(this.config);
        const keys = entries.map(entry => orderKey(scope, entryOrder(entry)));
        const records = new Map((await this.repository.findByOrderKeys([...new Set(keys)])).map(r => [r.order_key, r]));
        const open = [...records.values()].filter(r => !r.completed_at);
        const captures = groupByScreening(await this.repository.capturesOf(open.map(r => r.id)));

        const result: WorklistEntryDto[] = [];
        for (const [i, entry] of entries.entries()) {
            const record = records.get(keys[i]);
            if (record?.completed_at) continue;
            const submission = record ? toStatus(record, captures) : null;
            result.push({ ...entry, source_scope: scope, ...(submission ? { submission } : {}) });
        }
        return result;
    }

    // Gives up on a screening that cannot finish. The row stays for audit, captures already
    // queued still go to PACS, and the order returns to the worklist for a new screening.
    // Never completes anything: a delivered screening cannot be released.
    async release(id: string, by: string, reason: ReleaseReason): Promise<ScreeningStatus> {
        await this.reconcile(); // a screening whose last image just landed is completed, not released
        if (!await this.repository.find(id)) throw new ScreeningNotFoundError('Screening not found.');
        if (await this.repository.markReleased(id, new Date().toISOString(), by, reason)) {
            this.logger.info(`screening ${id} released by ${by} (${reason})`);
        }
        // The update changes only a live row. An earlier release leaves the row released
        // (answered with its status); otherwise it was delivered.
        const current = (await this.repository.find(id))!;
        if (!current.released_at) throw new ScreeningConflictError(DELIVERED_MESSAGE);
        return this.statusOf(current);
    }

    // Records activity on a screening, so the inactivity backstop measures from it.
    async touch(id: string | null): Promise<void> {
        if (id) await this.repository.touch(id, new Date().toISOString());
    }

    // The backstop for an unattended box: releases a screening that cannot finish and
    // that nobody has touched for screening_expiry_days. Anything still queued or sending
    // is left alone, so a long PACS outage that is still retrying never expires.
    async expire(now = new Date()): Promise<string[]> {
        const days = this.config.screening_expiry_days;
        if (days === 0) return [];
        await this.reconcile();
        const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
        const idle = await this.repository.findIdleSince(cutoff);
        if (!idle.length) return [];
        const captures = groupByScreening(await this.repository.capturesOf(idle.map(r => r.id)));
        const expired: string[] = [];
        for (const manifest of idle) {
            if (!EXPIRABLE.includes(toStatus(manifest, captures).state)) continue;
            // The write re-checks idleness and that nothing is queued or sending.
            if (await this.repository.markExpiredIfIdle(manifest.id, now.toISOString(), EXPIRY_ACTOR, cutoff)) expired.push(manifest.id);
        }
        if (expired.length) this.logger.warn(`released ${expired.length} screening(s) idle for ${days} day(s): ${expired.join(', ')}`);
        return expired;
    }

    // The completion rule: a manifest is complete when every declared capture exists,
    // belongs to it, and has a confirmed C-STORE (SENT with sent_at). The arrived count
    // never decides it. Re-run on every read, so a crash between markSent and here is
    // repaired by the next request. A capture that was SENT in this snapshot did reach
    // PACS, so completing from it stays true even if an operator re-sends it meanwhile;
    // completed_at is never cleared, so a re-send cannot reopen the order.
    private async reconcile(): Promise<void> {
        const open = await this.repository.findIncomplete();
        if (!open.length) return;
        const captures = groupByScreening(await this.repository.capturesOf(open.map(r => r.id)));
        const done = open.filter(manifest => {
            const members = captures.get(manifest.id);
            return (JSON.parse(manifest.capture_ids) as string[]).every(clientId => {
                const capture = members?.get(clientId);
                return capture?.status === CaptureStatus.SENT && capture.sent_at !== null;
            });
        });
        if (done.length) await this.repository.markCompleted(done.map(r => r.id), new Date().toISOString());
    }
}

function releasedCutoff(): string { return new Date(Date.now() - RELEASED_LISTED_DAYS * DAY_MS).toISOString(); }

function sameManifest(row: ScreeningEntity, scope: string, key: string, ids: string): boolean {
    return row.source_scope === scope && row.order_key === key && row.capture_ids === ids;
}

function entryOrder(entry: WorklistEntryDto) {
    return { accession_number: entry.accession_number, study_instance_uid: entry.study_instance_uid, step_id: entry.scheduled?.step_id };
}

type CapturesByScreening = Map<string, Map<string, ScreeningCaptureRow>>;

function groupByScreening(captures: ScreeningCaptureRow[]): CapturesByScreening {
    const groups: CapturesByScreening = new Map();
    for (const capture of captures) {
        let group = groups.get(capture.screening_id);
        if (!group) groups.set(capture.screening_id, group = new Map());
        group.set(capture.client_capture_id, capture);
    }
    return groups;
}

function toStatus(manifest: ScreeningEntity, captures: CapturesByScreening): ScreeningStatus {
    const byClient = captures.get(manifest.id);
    const members = (JSON.parse(manifest.capture_ids) as string[]).map(clientId => {
        const capture = byClient?.get(clientId);
        return { capture_id: clientId, gateway_capture_id: capture?.id ?? null, status: capture?.status ?? 'MISSING' };
    });
    const state: ScreeningState = manifest.completed_at ? 'COMPLETED'
        : manifest.released_at ? 'RELEASED'
        : members.some(c => c.status === CaptureStatus.FAILED) ? 'NEEDS_ATTENTION'
        : members.some(c => c.status === 'MISSING') ? 'UPLOAD_PENDING'
        : 'AWAITING_PACS';
    return {
        id: manifest.id, source_scope: manifest.source_scope,
        order: { accession_number: manifest.accession_number, study_instance_uid: manifest.study_instance_uid, step_id: manifest.step_id },
        state, created_at: manifest.created_at, last_activity_at: manifest.last_activity_at, completed_at: manifest.completed_at,
        released_at: manifest.released_at, released_by: manifest.released_by, release_reason: manifest.release_reason, captures: members,
    };
}
