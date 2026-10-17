import { defineConfig } from 'orval';
import { existsSync } from 'node:fs';

const schemaTarget = [
  '../../../py/free2z/dj/free2z/openapi/f2z.yaml',
  '../../../f2z.yaml'
].find((path) => existsSync(path));

if (!schemaTarget) {
  throw new Error('Could not find the Free2Z OpenAPI schema for Orval');
}

export default defineConfig({
  f2z: {
    input: {
      target: schemaTarget
    },
    output: {
      target: 'src/lib/api',
      client: 'svelte-query',
      mode: 'tags-split',
      formatter: 'prettier',
      override: {
        fetch: {
          includeHttpResponseReturnType: false
        },
        mutator: {
          path: 'src/lib/api/mutator.ts',
          name: 'customInstance'
        }
      }
    }
  }
});
