import { describe, expect, test } from 'bun:test';
import { maskEmailText } from '@/utils/format';

describe('maskEmailText', () => {
  test('masks the local part and domain while preserving email shape', () => {
    expect(maskEmailText('user@example.com')).toBe('****@*******.***');
  });

  test('masks emails embedded in filenames without changing surrounding text', () => {
    expect(maskEmailText('codex-user@example.com-team.json', ['user@example.com'])).toBe(
      'codex-****@*******.***-team.json'
    );
  });

  test('keeps punctuation and non-email text intact', () => {
    expect(maskEmailText('Account: user@example.com, ready')).toBe(
      'Account: ****@*******.***, ready'
    );
    expect(maskEmailText('no account here')).toBe('no account here');
  });
});
