import type { Filter } from 'nostr-tools';
import { PIN_HINT_LOOKBACK_BUCKETS } from '../crypto/constants';
import { computePinHintFromRoot } from '../crypto/pin';
import { EVENT_KIND_RENDEZVOUS } from './types';

/** Build the receiver's rendezvous query for the accepted rotation buckets. */
export async function createRendezvousLookupFilter(
  root: CryptoKey,
): Promise<Filter> {
  const hints = await Promise.all(
    Array.from({ length: PIN_HINT_LOOKBACK_BUCKETS + 1 }, (_, offset) =>
      computePinHintFromRoot(root, offset),
    ),
  );

  return {
    kinds: [EVENT_KIND_RENDEZVOUS],
    '#h': hints,
    limit: 10,
  };
}
