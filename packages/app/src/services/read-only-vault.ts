import type { VaultManager } from './vault-manager';

export const READ_ONLY_ERROR = 'This credential is read-only: the vault cannot be modified with it';

const WRITE_METHODS = new Set<PropertyKey>([
  'writeFile',
  'deleteFile',
  'moveFile',
  'createDirectory',
]);

/**
 * A view of the vault that refuses every mutation.
 *
 * Read sessions are not offered write tools in the first place; this is the
 * backstop for a tool that writes but was registered as read-only, which
 * would otherwise be a silent privilege escalation.
 */
export function readOnlyVaultManager(vault: VaultManager): VaultManager {
  return new Proxy(vault, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') return original;
      if (WRITE_METHODS.has(prop)) {
        // async, so the refusal is a rejected promise like any other vault
        // failure rather than a synchronous throw.
        return async () => {
          throw new Error(READ_ONLY_ERROR);
        };
      }
      return original.bind(target);
    },
  });
}
