import { mintToken, pairExtension } from '#server/auth.ts';
import { os } from './base.ts';

/**
 * Trades a pairing code printed on the daemon's stdout for a bearer token.
 *
 * The code is the proof of physical access to the machine — it is single use,
 * expires in ten minutes, and is compared in constant time. The token it
 * returns is shown exactly once; only its SHA-256 is stored.
 */
export const pair = os.pair.handler(async ({ context, errors, input }) => {
  const { state } = context;

  if (!state.pairingCodes.consume(input.code)) {
    throw errors.UNAUTHORIZED({ message: 'That pairing code is invalid or has expired.' });
  }

  const token = mintToken();
  pairExtension(state.config, {
    extensionId: input.extensionId,
    label: input.label,
    token,
  });
  await state.persist();

  return { token };
});
