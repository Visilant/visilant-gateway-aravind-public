import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTelemetryEvent1794511194852 implements MigrationInterface {
    name = 'AddTelemetryEvent1794511194852'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "telemetry_event" ("event_id" text PRIMARY KEY NOT NULL, "schema_version" integer NOT NULL, "type" text NOT NULL, "occurred_at" text NOT NULL, "received_at" text NOT NULL, "site_id" text NOT NULL, "gateway_id" text NOT NULL, "device_id" text, "session_id" text, "capture_id" text, "screening_id" text, "payload" text NOT NULL, "sent_at" text)`);
        await queryRunner.query(`CREATE INDEX "idx_telemetry_occurred" ON "telemetry_event" ("occurred_at") `);
        await queryRunner.query(`CREATE INDEX "idx_telemetry_push" ON "telemetry_event" ("sent_at", "event_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "idx_telemetry_push"`);
        await queryRunner.query(`DROP INDEX "idx_telemetry_occurred"`);
        await queryRunner.query(`DROP TABLE "telemetry_event"`);
    }

}
