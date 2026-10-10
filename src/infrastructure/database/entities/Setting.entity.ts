import { Column, Entity, PrimaryColumn } from 'typeorm';

// Values the gateway generates for itself, as opposed to the ones a field engineer
// writes in config.json. The JWT signing secrets live here: baking them into the
// installer would make a token minted at one centre valid at every other centre.
@Entity('setting')
export class SettingEntity {
    @PrimaryColumn({ type: 'text' })
    key!: string;

    @Column({ type: 'text' })
    value!: string;

    @Column({ type: 'text' })
    created_at!: string;
}
