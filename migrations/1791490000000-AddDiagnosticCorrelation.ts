import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddDiagnosticCorrelation1791490000000 implements MigrationInterface {
    name = 'AddDiagnosticCorrelation1791490000000';
    async up(runner: QueryRunner): Promise<void> {
        for (const name of ['diagnostic_run_id', 'diagnostic_operation_id', 'enqueued_at']) await runner.query(`ALTER TABLE capture ADD COLUMN ${name} text`);
    }
    async down(runner: QueryRunner): Promise<void> {
        for (const name of ['diagnostic_run_id', 'diagnostic_operation_id', 'enqueued_at']) await runner.query(`ALTER TABLE capture DROP COLUMN ${name}`);
    }
}
