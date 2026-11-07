// Browser bundle entry for near-api-js v5.
//
// near-api-js v5 ships no UMD dist build (the old
// https://cdn.jsdelivr.net/npm/near-api-js@5.1.1/dist/near-api-js.min.js
// returns 404), so the demo site bundles the library locally instead.
// This entry exposes the full library as window.nearApi, the global the
// site's app.js expects (nearApi.connect, nearApi.keyStores,
// nearApi.WalletConnection).
import * as nearApi from 'near-api-js';

window.nearApi = nearApi;
