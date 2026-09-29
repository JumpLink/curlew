// Temporary single-suite entry for a fast TDD loop (`gjsify test --entry tests/tmpsuite.mts`).
// Deleted before any commit — never part of the suite list in test.mts.
import { run } from '@gjsify/unit';

import storeDeliveryFollow from './unit/store/delivery-follow.test.ts';
import daemon from './unit/core/daemon.test.ts';

run({ storeDeliveryFollow, daemon });
