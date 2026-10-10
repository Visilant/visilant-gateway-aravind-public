import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSettingTable1789386230666 implements MigrationInterface {
    name = 'AddSettingTable1789386230666'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "setting" ("key" text PRIMARY KEY NOT NULL, "value" text NOT NULL, "created_at" text NOT NULL)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "setting"`);
    }

}
