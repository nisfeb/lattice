// Search finds words as they are written. The omnibar split its query on
// every non-alphanumeric byte, so a hyphenated or dotted word, which the
// index holds whole, was never matched. And the memory stemmer took
// release and released to different stems, so neither found the other.
//   LATTICE_URL=http://localhost:<port> LATTICE_COOKIE=<cookie file> node scripts/ui-omnisearch.mjs
import { shipEnv, makeCheck, waitFor, seed } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'uos' + Date.now().toString(36);
const H = { Cookie: env.cookie };
const api = (p, o = {}) => fetch(env.base + '/apps/lattice/' + p, { headers: H, ...o });
const post = (p, body) => api(p, { method: 'POST', body });
const q = encodeURIComponent;
const P = RUN + '/notes';

await seed(env, [[P, 'met ~zalbex-wolnup about ' + RUN + '.hoon today\n']]);
check('reindex', (await post('search-reindex', '')).ok);
const keys = async (query) => {
  const r = await api('content-search?q=' + q(query));
  if (!r.ok) return null;
  const j = await r.json();
  const ki = j.columns.indexOf('key');
  return j.rows.map((row) => row[ki]);
};
check('a hyphenated word finds the page', await waitFor(async () =>
  ((await keys('zalbex-wolnup')) || []).includes(P), 30000, 1000));
check('a dotted word finds the page', ((await keys(RUN + '.hoon')) || []).includes(P));
const j = await (await api('content-search?q=' + q('of the a'))).json();
check.eq('a query of stop words asks for no term', (j.terms || []).length, 0);

const K = '/' + RUN + '/m';
check('save a memory', (await post('know-save?key=' + q(K), 'we released the quarterly zorblat build')).ok);
const found = async (query) => {
  const r = await api('know-search?k=10&q=' + q(query));
  return r.ok && (await r.json()).results.some((x) => x.key === K);
};
check('release finds released', await waitFor(() => found('release'), 30000, 1000));
check('releases finds released', await found('releases'));

await post('know-delete?key=' + q(K), '');
await post('page-del?name=' + q(P), '');
check.done();
