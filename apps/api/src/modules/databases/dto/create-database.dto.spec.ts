import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateDatabaseDto } from './create-database.dto';

const base = { type: 'POSTGRESQL', serverId: 'srv-1' };

async function errorsFor(payload: Record<string, unknown>) {
  const dto = plainToInstance(CreateDatabaseDto, { ...base, ...payload });
  return validate(dto);
}

describe('CreateDatabaseDto validation', () => {
  it('accepts a valid name', async () => {
    const errors = await errorsFor({ name: 'my-db-1' });
    expect(errors).toHaveLength(0);
  });

  it('rejects a name with a newline', async () => {
    const errors = await errorsFor({ name: 'a\nb' });
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects a name with a semicolon', async () => {
    const errors = await errorsFor({ name: 'a;b' });
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects an uppercase/underscore name', async () => {
    const errors = await errorsFor({ name: 'A_UPPER' });
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects a password containing a quote', async () => {
    const errors = await errorsFor({ name: 'mydb', password: `pa"ss` });
    expect(errors.some((e) => e.property === 'password')).toBe(true);
    const single = await errorsFor({ name: 'mydb', password: "pa'ss" });
    expect(single.some((e) => e.property === 'password')).toBe(true);
  });

  it('accepts a valid password', async () => {
    const errors = await errorsFor({ name: 'mydb', password: 'Str0ng_p@ss.word!' });
    expect(errors).toHaveLength(0);
  });
});
