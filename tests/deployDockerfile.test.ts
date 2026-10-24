import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const lines = readFileSync(new URL('../deploy/Dockerfile', import.meta.url), 'utf8').split('\n');
const isFrom = (line: string) => /^\s*FROM\s/i.test(line);
const firstFrom = lines.findIndex(isFrom);
const globalArgs = lines
  .slice(0, firstFrom)
  .map((line) => /^\s*ARG\s+(\w+)/i.exec(line)?.[1])
  .filter((name): name is string => name !== undefined);
const fromVariables = lines
  .filter(isFrom)
  .flatMap((line) => [...line.matchAll(/\$\{?(\w+)/g)].map((match) => match[1]));

describe('deploy Dockerfile', () => {
  test('declares every FROM variable before the first stage', () => {
    expect(fromVariables).toContain('BASE_IMAGE');
    expect(fromVariables.filter((name) => !globalArgs.includes(name))).toEqual([]);
  });
});
