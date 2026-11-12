import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTelemetryEvent1794514621172 implements MigrationInterface {
    name = 'AddTelemetryEvent1794514621172'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "telemetry_event" ("seq" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "event_id" text NOT NULL, "schema_version" integer NOT NULL, "type" text NOT NULL, "occurred_at" text NOT NULL, "received_at" text NOT NULL, "site_id" text NOT NULL, "gateway_id" text NOT NULL, "device_id" text, "session_id" text, "capture_id" text, "screening_id" text, "authenticated" boolean, "payload" text NOT NULL, "sent_at" text, "push_attempts" integer NOT NULL DEFAULT (0), "quarantined_at" text, "quarantine_reason" text)`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_telemetry_event_id" ON "telemetry_event" ("event_id") `);
        await queryRunner.query(`CREATE INDEX "idx_telemetry_occurred" ON "telemetry_event" ("occurred_at") `);
        await queryRunner.query(`CREATE INDEX "idx_telemetry_push" ON "telemetry_event" ("sent_at", "quarantined_at", "seq") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "idx_telemetry_push"`);
        await queryRunner.query(`DROP INDEX "idx_telemetry_occurred"`);
        await queryRunner.query(`DROP INDEX "idx_telemetry_event_id"`);
        await queryRunner.query(`DROP TABLE "telemetry_event"`);
    }

}
