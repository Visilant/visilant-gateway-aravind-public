import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClientCaptureId1791417600000 implements MigrationInterface {
    name = 'AddClientCaptureId1791417600000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "capture" ADD COLUMN "client_capture_id" text');
        await queryRunner.query('CREATE UNIQUE INDEX "idx_capture_client_id" ON "capture" ("client_capture_id")');
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP INDEX "idx_capture_client_id"');
        await queryRunner.query('ALTER TABLE "capture" DROP COLUMN "client_capture_id"');
    }
}
