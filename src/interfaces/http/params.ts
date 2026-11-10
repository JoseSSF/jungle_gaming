import { InvalidCommandError } from '../../application/errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@\-]{1,128}$/;

export function uuidParam(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidCommandError('INVALID_PAYLOAD', `${name} must be a UUID`, [{ path: name, message: 'must be a UUID' }]);
  }
  return value.toLowerCase();
}

export function identifierParam(value: string, name: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidCommandError('INVALID_PAYLOAD', `${name} is invalid`, [{ path: name, message: 'is invalid' }]);
  }
  return value;
}
