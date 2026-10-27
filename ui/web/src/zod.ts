// zod 4 probes `Function("")` when a schema is made, to choose a faster parser. The page's CSP
// has no 'unsafe-eval', so the probe would be refused and reported as a violation. jitless
// turns it off. This must run before any schema is made, here and in @ag-ui/core (E4), so
// main.tsx imports it first and every file takes `z` from here, never from "zod". The config is
// global to zod, so it also covers the schemas of @ag-ui/core (which imports "zod/v4").
import { z } from "zod";

z.config({ jitless: true });

export { z };
