import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { CaptureEntity, CaptureStatus, UserEntity } from '../src/infrastructure/database/entities';
import { CaptureRepository } from '../src/infrastructure/database/repositories';

let database: DataSource;
let repository: CaptureRepository;

function capture(id: string, status: CaptureStatus): CaptureEntity {
    return Object.assign(new CaptureEntity(), {
        id,
        dicom_path: `${id}.dcm`,
        status,
        study_instance_uid: `1.2.3.${id}`,
        series_instance_uid: `1.2.3.${id}.1`,
        sop_instance_uid: `1.2.3.${id}.1.1`,
        accession_number: `ACC${id}`,
        attempts: 0,
        next_attempt_at: null,
        last_error: null,
        created_by: null,
        created_at: new Date().toISOString(),
        sent_at: null,
    });
}

beforeEach(async () => {
    // Real schema via the real migrations, so these tests fail if a migration drifts
    // from the entities.
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize();
    await database.runMigrations();
    repository = new CaptureRepository(database);
});

afterEach(async () => {
    await database.destroy();
});

describe('schema', () => {
    // foreign_keys is OFF by default in SQLite, silently, on every connection. If the
    // pragma ever stops being applied the FK becomes decorative and nothing else fails.
    it('adds the client key to an existing database without losing capture history', async () => {
        await repository.create(capture('legacy', CaptureStatus.SENT));
        await database.undoLastMigration(); // Screening release migration
        await database.undoLastMigration(); // Screening migration
        // Undo the diagnostics migration before testing the client-ID migration.
        await database.undoLastMigration();
        await database.undoLastMigration();
        const columns = await database.query('PRAGMA table_info(capture)');
        expect(columns.some((column: { name: string }) => column.name === 'client_capture_id')).toBe(false);
        await database.runMigrations();
        expect((await repository.findById('legacy'))?.client_capture_id).toBeNull();
        expect((await repository.findById('legacy'))?.status).toBe(CaptureStatus.SENT);
    });

    it('enforces foreign keys', async () => {
        const [{ foreign_keys }] = await database.query('PRAGMA foreign_keys');
        expect(foreign_keys).toBe(1);

        const orphan = capture('a', CaptureStatus.PENDING);
        orphan.created_by = 'no-such-user';
        await expect(database.getRepository(CaptureEntity).save(orphan)).rejects.toThrow(/FOREIGN KEY/i);
    });

    it('rejects a duplicate SOP Instance UID', async () => {
        const repo = database.getRepository(CaptureEntity);
        await repo.save(capture('a', CaptureStatus.PENDING));

        const duplicate = capture('b', CaptureStatus.PENDING);
        duplicate.sop_instance_uid = '1.2.3.a.1.1';
        await expect(repo.save(duplicate)).rejects.toThrow(/UNIQUE/i);
    });

    it('enforces client id uniqueness while accepting multiple legacy null keys', async () => {
        const first = capture('a', CaptureStatus.PENDING);
        first.client_capture_id = 'client-1';
        await repository.create(first);
        expect((await repository.findByClientId('client-1'))?.id).toBe('a');
        const duplicate = capture('b', CaptureStatus.PENDING);
        duplicate.client_capture_id = 'client-1';
        await expect(repository.create(duplicate)).rejects.toThrow(/UNIQUE/);
        await repository.create(capture('c', CaptureStatus.PENDING));
        await repository.create(capture('d', CaptureStatus.PENDING));
        expect(await repository.findRecent()).toHaveLength(3);
    });

    it('keeps a capture when its creator is deleted', async () => {
        const user = await database.getRepository(UserEntity).save(Object.assign(new UserEntity(), {
            id: 'u1', username: 'op', email: null, password: 'x',
            display_name: null, role: 'OPERATOR', active: true, created_at: new Date().toISOString(),
        }));

        const row = capture('a', CaptureStatus.PENDING);
        row.created_by = user.id;
        await database.getRepository(CaptureEntity).save(row);

        await database.getRepository(UserEntity).delete(user.id);

        // ON DELETE SET NULL: removing an operator must never destroy the record of
        // what was sent to the archive.
        const kept = await database.getRepository(CaptureEntity).findOneByOrFail({ id: 'a' });
        expect(kept.created_by).toBeNull();
    });
});

describe('countByStatus', () => {
    it('reports every status, including those with no rows', async () => {
        const repo = database.getRepository(CaptureEntity);
        await repo.save([
            capture('a', CaptureStatus.PENDING),
            capture('b', CaptureStatus.PENDING),
            capture('c', CaptureStatus.SENT),
        ]);

        expect(await repository.countByStatus()).toEqual({
            PENDING: 2, SENDING: 0, SENT: 1, FAILED: 0,
        });
    });
});

describe('resetOrphanedSending', () => {
    // The failure this exists to prevent: power loss mid-send leaves rows in SENDING
    // with no other process to reclaim them, and those captures are stranded forever.
    it('returns rows stranded mid-send to PENDING', async () => {
        const repo = database.getRepository(CaptureEntity);
        await repo.save([
            capture('a', CaptureStatus.SENDING),
            capture('b', CaptureStatus.SENDING),
            capture('c', CaptureStatus.PENDING),
            capture('d', CaptureStatus.SENT),
            capture('e', CaptureStatus.FAILED),
        ]);

        expect(await repository.resetOrphanedSending()).toBe(2);
        expect(await repository.countByStatus()).toEqual({
            PENDING: 3, SENDING: 0, SENT: 1, FAILED: 1,
        });
    });

    it('clears any backoff so recovered captures are retried immediately', async () => {
        const stranded = capture('a', CaptureStatus.SENDING);
        stranded.next_attempt_at = '2099-01-01T00:00:00.000Z';
        await database.getRepository(CaptureEntity).save(stranded);

        await repository.resetOrphanedSending();

        const recovered = await database.getRepository(CaptureEntity).findOneByOrFail({ id: 'a' });
        expect(recovered.next_attempt_at).toBeNull();
    });

    it('is a no-op when nothing was stranded', async () => {
        await database.getRepository(CaptureEntity).save(capture('a', CaptureStatus.PENDING));
        expect(await repository.resetOrphanedSending()).toBe(0);
    });
});

describe('lookups added for the operator page', () => {
    const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

    it('findByStudy returns only that study, newest first', async () => {
        await repository.create({ ...capture('a', CaptureStatus.SENT), study_instance_uid: '1.2.3.s', created_at: at(1) });
        await repository.create({ ...capture('b', CaptureStatus.SENT), study_instance_uid: '1.2.3.s', created_at: at(2) });
        await repository.create({ ...capture('c', CaptureStatus.PENDING), study_instance_uid: '1.2.3.t', created_at: at(3) });
        expect((await repository.findByStudy('1.2.3.s')).map((row) => row.id)).toEqual(['b', 'a']);
        expect(await repository.findByStudy('1.2.3.none')).toEqual([]);
    });

    it('findByDiagnosticRunId returns the run’s captures oldest first and nothing else', async () => {
        await repository.create({ ...capture('a', CaptureStatus.SENT), diagnostic_run_id: 'run-1', created_at: at(2) });
        await repository.create({ ...capture('b', CaptureStatus.PENDING), diagnostic_run_id: 'run-1', created_at: at(1) });
        await repository.create({ ...capture('c', CaptureStatus.SENT), diagnostic_run_id: 'run-2', created_at: at(3) });
        await repository.create({ ...capture('d', CaptureStatus.SENT), created_at: at(4) });
        expect((await repository.findByDiagnosticRunId('run-1')).map((row) => row.id)).toEqual(['b', 'a']);
    });

    it('findSentBeyond pages SENT rows newest first, skipping the window', async () => {
        for (let i = 1; i <= 5; i++) {
            await repository.create({ ...capture(`s${i}`, CaptureStatus.SENT), sent_at: at(i) });
        }
        await repository.create({ ...capture('p', CaptureStatus.PENDING), sent_at: null });
        await repository.create({ ...capture('f', CaptureStatus.FAILED), sent_at: at(9) });
        expect((await repository.findSentBeyond(2, 10)).map((row) => row.id)).toEqual(['s3', 's2', 's1']);
        expect((await repository.findSentBeyond(2, 2)).map((row) => row.id)).toEqual(['s3', 's2']);
        expect(await repository.findSentBeyond(10, 10)).toEqual([]);
    });
});

test('capture lookups break timestamp ties deterministically and status lists are newest first', async () => {
    const shared = { study_instance_uid: '1.2.3', diagnostic_run_id: 'run', created_at: '2026-01-01T00:00:00.000Z', sent_at: '2026-01-01T00:01:00.000Z' };
    for (const id of ['a', 'c', 'b']) await repository.create({ ...capture(id, CaptureStatus.SENT), ...shared });
    expect((await repository.findSentBeyond(1, 10)).map(row => row.id)).toEqual(['b', 'a']);
    expect((await repository.findByStudy('1.2.3')).map(row => row.id)).toEqual(['c', 'b', 'a']);
    expect((await repository.findByDiagnosticRunId('run')).map(row => row.id)).toEqual(['a', 'b', 'c']);
    await repository.create({ ...capture('new', CaptureStatus.SENT), ...shared, created_at: '2026-01-02T00:00:00.000Z' });
    expect((await repository.findByStatus(CaptureStatus.SENT)).map(row => row.id)).toEqual(['new', 'c', 'b', 'a']);
});
