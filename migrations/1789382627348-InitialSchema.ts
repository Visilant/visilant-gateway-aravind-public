import { MigrationInterface, QueryRunner } from "typeorm";

// Initial gateway schema: the send queue and local operators.
//
// Collapsed from the generated output, which created `capture` without its foreign key
// and then dropped and rebuilt the table to attach one — SQLite cannot ALTER TABLE ADD
// CONSTRAINT, so TypeORM always emits that dance. On an initial schema it is pure noise;
// the FK is inlined here instead. Verified to leave zero drift against the entities.
export class InitialSchema1789382627348 implements MigrationInterface {
    name = 'InitialSchema1789382627348'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "user" ("id" text PRIMARY KEY NOT NULL, "username" text NOT NULL, "email" text, "password" text NOT NULL, "display_name" text, "role" text NOT NULL DEFAULT ('OPERATOR'), "active" boolean NOT NULL DEFAULT (1), "created_at" text NOT NULL, CONSTRAINT "UQ_78a916df40e02a9deb1c4b75edb" UNIQUE ("username"))`);
        await queryRunner.query(`CREATE TABLE "capture" ("id" text PRIMARY KEY NOT NULL, "dicom_path" text NOT NULL, "status" text NOT NULL, "study_instance_uid" text NOT NULL, "series_instance_uid" text NOT NULL, "sop_instance_uid" text NOT NULL, "accession_number" text NOT NULL, "attempts" integer NOT NULL DEFAULT (0), "next_attempt_at" text, "last_error" text, "created_by" text, "created_at" text NOT NULL, "sent_at" text, CONSTRAINT "UQ_ff5a1def27e5a3f9a2acda21d3e" UNIQUE ("sop_instance_uid"), CONSTRAINT "FK_ab42583fe71893a10b2eb3f2dac" FOREIGN KEY ("created_by") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE NO ACTION)`);
        await queryRunner.query(`CREATE INDEX "idx_capture_due" ON "capture" ("status", "next_attempt_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "idx_capture_due"`);
        await queryRunner.query(`DROP TABLE "capture"`);
        await queryRunner.query(`DROP TABLE "user"`);
    }

}
