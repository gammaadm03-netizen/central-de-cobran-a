import { createCollectionReferenceGateway } from './handler.mjs';

Deno.serve(createCollectionReferenceGateway({
  env: (name: string) => Deno.env.get(name),
  log: (event: string) => console.warn(`collection-reference-import:${event}`),
}));
